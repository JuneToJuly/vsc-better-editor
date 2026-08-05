package local.cgtl.flow;

import java.io.File;
import java.io.Writer;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Deque;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.Collection;
import java.util.concurrent.atomic.AtomicLong;
import javax.tools.JavaCompiler;
import javax.tools.ToolProvider;

/**
 * Stable bootstrap around the snapshot agent. The line transformer is compiled
 * against the exact Byte Buddy jar selected by the Gradle init script, keeping
 * the packaged agent compatible with offline repositories and configurable
 * Byte Buddy versions.
 */
public final class BootstrapAgent {
  private static volatile AtomicLong sharedSequence;
  private static volatile ThreadLocal<?> sharedCalls;
  private static volatile ThreadLocal<?> sharedDepth;
  private static volatile Writer sharedOutput;
  private static volatile int sharedMaxEvents;
  private static volatile Field callIdField;
  private static volatile boolean consoleLines;
  private static final AtomicLong lineStateFailures = new AtomicLong();
  private static final IdentityHashMap<Object, SnapshotCacheEntry> snapshotCache = new IdentityHashMap<>();
  private static final AtomicLong snapshotIds = new AtomicLong();
  private static final int snapshotMaxDepth = Integer.getInteger("cgtl.flow.lineState.maxDepth", 2);
  private static final int snapshotMaxFields = Integer.getInteger("cgtl.flow.lineState.maxFields", 30);
  private static final int snapshotMaxItems = Integer.getInteger("cgtl.flow.lineState.maxCollectionItems", 20);

  private static final class SnapshotCacheEntry {
    final String id;
    String fingerprint;
    long checkpointSequence;
    SnapshotCacheEntry(String id) { this.id = id; }
  }

  private BootstrapAgent() {}

  public static void premain(String args, Instrumentation instrumentation) {
    try {
      Class<?> flowAgent = Class.forName("local.cgtl.flow.FlowAgent", true, ClassLoader.getSystemClassLoader());
      Method premain = flowAgent.getMethod("premain", String.class, Instrumentation.class);
      premain.invoke(null, args, instrumentation);
      bindRecorder(flowAgent);
      consoleLines = Boolean.parseBoolean(System.getProperty("cgtl.flow.consoleLines", "true"));
      System.err.println("[CGTL FLOW] Line state validation mode=" + System.getProperty("cgtl.flow.lineState", "receiver")
          + " maxDepth=" + snapshotMaxDepth
          + " maxFields=" + snapshotMaxFields
          + " maxItems=" + snapshotMaxItems);
      installLineTransformer(instrumentation);
    } catch (Throwable error) {
      System.err.println("[CGTL FLOW] Ordered line replay disabled: " + error);
      error.printStackTrace(System.err);
    }
  }

  private static void bindRecorder(Class<?> flowAgent) throws Exception {
    Class<?> recorder = Class.forName(flowAgent.getName() + "$Recorder", true, flowAgent.getClassLoader());
    sharedSequence = (AtomicLong) readStatic(recorder, "sequence");
    sharedCalls = (ThreadLocal<?>) readStatic(recorder, "calls");
    sharedDepth = (ThreadLocal<?>) readStatic(recorder, "depth");
    sharedOutput = (Writer) readStatic(recorder, "output");
    sharedMaxEvents = ((Number) readStatic(recorder, "maxEvents")).intValue();
  }

  private static Object readStatic(Class<?> type, String name) throws Exception {
    Field field = type.getDeclaredField(name);
    field.setAccessible(true);
    return field.get(null);
  }

  /** Called from injected bytecode at each source line-number boundary. */
  public static void lineState(String className, String methodName, String descriptor, int line,
      Object receiver, String[] localNames, Object[] localValues) {
    try {
      AtomicLong sequence = sharedSequence;
      Writer output = sharedOutput;
      if (sequence == null || output == null || line <= 0) return;
      long eventSequence = sequence.incrementAndGet();
      if (eventSequence > sharedMaxEvents) return;

      long callId = currentCallId();
      int depth = currentDepth();
      String sourceFile = sourceFile(className);
      String json = "{\"sequence\":" + eventSequence +
          ",\"event\":\"line\"" +
          ",\"callId\":" + callId +
          ",\"invocationId\":" + callId +
          ",\"className\":" + quote(className) +
          ",\"methodName\":" + quote(methodName) +
          ",\"descriptor\":" + quote(descriptor) +
          ",\"sourceFile\":" + quote(sourceFile) +
          ",\"line\":" + line +
          ",\"depth\":" + depth +
          ",\"threadId\":" + Thread.currentThread().getId() +
          ",\"threadName\":" + quote(Thread.currentThread().getName()) +
          ",\"frameReceiver\":" + snapshotForLine(receiver) +
          ",\"frameLocals\":" + localsJson(localNames, localValues) + "}";
      synchronized (Class.forName("local.cgtl.flow.FlowAgent$Recorder")) {
        output.write(json);
        output.write("\n");
        output.flush();
      }
      if (consoleLines) {
        System.err.println("[CGTL FLOW] #" + eventSequence
            + " [thread=" + Thread.currentThread().getName()
            + " call=" + callId
            + " depth=" + depth + "] "
            + className + "." + methodName + "():" + line);
      }
    } catch (Throwable error) {
      // A trace must never change application behavior, but validation builds
      // must make capture failures visible. Limit output to avoid flooding.
      long failures = lineStateFailures.incrementAndGet();
      if (failures <= 20) {
        System.err.println("[CGTL FLOW] Line state callback failed for " + className + "." + methodName + "():" + line + " - " + error);
        error.printStackTrace(System.err);
      }
    }
  }

  private static String localsJson(String[] names, Object[] values) {
    if (names == null || values == null) return "{}";
    StringBuilder out = new StringBuilder("{");
    int length = Math.min(names.length, values.length);
    for (int i = 0; i < length; i++) {
      if (i > 0) out.append(',');
      out.append(quote(names[i])).append(':')
          .append(snapshotForLine(values[i]));
    }
    return out.append('}').toString();
  }

  private static String snapshotForLine(Object value) {
    try { return snapshot(value, 0, new IdentityHashMap<>(), true); }
    catch (Throwable error) { return "{\"type\":\"unavailable\",\"value\":" + quote("<" + error.getClass().getSimpleName() + ">") + "}"; }
  }

  /**
   * Root receivers are always emitted with their direct fields. Referenced objects
   * are checkpointed by identity and a bounded structural fingerprint. If the
   * referenced object did not change, only a snapshotRef is written.
   */
  private static String snapshot(Object value, int level, IdentityHashMap<Object, Boolean> seen, boolean forceRoot) {
    if (value == null) return "null";
    if (isScalar(value)) return scalarSnapshot(value);
    Class<?> type = value.getClass();
    if (seen.put(value, Boolean.TRUE) != null) {
      SnapshotCacheEntry cached = cacheEntry(value, type);
      return refSnapshot(cached, type, "cycle");
    }

    SnapshotCacheEntry cache = cacheEntry(value, type);
    String fingerprint = fingerprint(value, level, new IdentityHashMap<>());
    boolean unchanged = !forceRoot && fingerprint.equals(cache.fingerprint);
    if (unchanged) return refSnapshot(cache, type, "unchanged");

    cache.fingerprint = fingerprint;
    cache.checkpointSequence = sharedSequence == null ? 0 : sharedSequence.get();
    String body;
    if (type.isArray()) {
      int length = Math.min(Array.getLength(value), snapshotMaxItems);
      StringBuilder out = new StringBuilder("[" );
      for (int i = 0; i < length; i++) {
        if (i > 0) out.append(',');
        out.append(level >= snapshotMaxDepth ? summary(Array.get(value, i)) : snapshot(Array.get(value, i), level + 1, seen, false));
      }
      body = "\"items\":" + out.append(']').toString() + ",\"size\":" + Array.getLength(value);
    } else if (value instanceof Map<?,?> map) {
      StringBuilder out = new StringBuilder("["); int i = 0;
      for (Map.Entry<?,?> entry : map.entrySet()) {
        if (i++ >= snapshotMaxItems) break;
        if (i > 1) out.append(',');
        out.append("{\"key\":").append(level >= snapshotMaxDepth ? summary(entry.getKey()) : snapshot(entry.getKey(), level + 1, seen, false));
        out.append(",\"value\":").append(level >= snapshotMaxDepth ? summary(entry.getValue()) : snapshot(entry.getValue(), level + 1, seen, false)).append('}');
      }
      body = "\"entries\":" + out.append(']').toString() + ",\"size\":" + map.size();
    } else if (value instanceof Collection<?> collection) {
      StringBuilder out = new StringBuilder("["); int i = 0;
      for (Object item : collection) {
        if (i++ >= snapshotMaxItems) break;
        if (i > 1) out.append(',');
        out.append(level >= snapshotMaxDepth ? summary(item) : snapshot(item, level + 1, seen, false));
      }
      body = "\"items\":" + out.append(']').toString() + ",\"size\":" + collection.size();
    } else if (level >= snapshotMaxDepth || type.getName().startsWith("java.")) {
      body = "\"value\":" + quote(identityText(value));
    } else {
      StringBuilder fields = new StringBuilder(); int count = 0;
      for (Class<?> current = type; current != null && current != Object.class && count < snapshotMaxFields; current = current.getSuperclass()) {
        for (Field field : current.getDeclaredFields()) {
          if (Modifier.isStatic(field.getModifiers()) || field.isSynthetic() || count >= snapshotMaxFields) continue;
          if (count++ > 0) fields.append(',');
          fields.append(quote(field.getName())).append(':');
          try {
            field.setAccessible(true);
            Object child = field.get(value);
            fields.append(level + 1 > snapshotMaxDepth ? summary(child) : snapshot(child, level + 1, seen, false));
          } catch (Throwable error) {
            fields.append("{\"type\":\"unavailable\",\"value\":" + quote("<" + error.getClass().getSimpleName() + ">") + "}");
          }
        }
      }
      body = "\"value\":" + quote(identityText(value)) + ",\"fields\":{" + fields + "}";
    }
    return "{\"snapshotId\":" + quote(cache.id) + ",\"checkpointSequence\":" + cache.checkpointSequence + ",\"type\":" + quote(type.getName()) + "," + body + "}";
  }

  private static boolean isScalar(Object value) {
    return value instanceof String || value instanceof Character || value instanceof Enum<?> || value instanceof Number || value instanceof Boolean;
  }
  private static String scalarSnapshot(Object value) {
    return "{\"type\":" + quote(value.getClass().getName()) + ",\"value\":" + quote(limit(String.valueOf(value), 500)) + "}";
  }
  private static SnapshotCacheEntry cacheEntry(Object value, Class<?> type) {
    synchronized (snapshotCache) {
      SnapshotCacheEntry entry = snapshotCache.get(value);
      if (entry == null) {
        entry = new SnapshotCacheEntry(type.getName() + "@" + Integer.toHexString(System.identityHashCode(value)) + "#" + snapshotIds.incrementAndGet());
        snapshotCache.put(value, entry);
      }
      return entry;
    }
  }
  private static String refSnapshot(SnapshotCacheEntry entry, Class<?> type, String reason) {
    return "{\"snapshotRef\":" + quote(entry.id) + ",\"checkpointSequence\":" + entry.checkpointSequence + ",\"type\":" + quote(type.getName()) + ",\"reason\":" + quote(reason) + "}";
  }
  private static String summary(Object value) {
    if (value == null) return "null";
    if (isScalar(value)) return scalarSnapshot(value);
    SnapshotCacheEntry entry = cacheEntry(value, value.getClass());
    return "{\"snapshotRef\":" + quote(entry.id) + ",\"checkpointSequence\":" + entry.checkpointSequence + ",\"type\":" + quote(value.getClass().getName()) + ",\"value\":" + quote(identityText(value)) + "}";
  }
  private static String fingerprint(Object value, int level, IdentityHashMap<Object, Boolean> seen) {
    if (value == null) return "null";
    if (isScalar(value)) return value.getClass().getName() + ":" + String.valueOf(value);
    if (seen.put(value, Boolean.TRUE) != null) return "cycle@" + System.identityHashCode(value);
    Class<?> type = value.getClass();
    StringBuilder out = new StringBuilder(type.getName()).append('@').append(System.identityHashCode(value));
    if (type.isArray()) {
      int n = Math.min(Array.getLength(value), snapshotMaxItems); out.append('[').append(Array.getLength(value)).append(']');
      for (int i=0;i<n;i++) out.append('|').append(level >= snapshotMaxDepth ? identityFingerprint(Array.get(value,i)) : fingerprint(Array.get(value,i), level+1, seen));
      return out.toString();
    }
    if (value instanceof Map<?,?> map) {
      out.append("|size=").append(map.size()); int i=0;
      for (Map.Entry<?,?> e:map.entrySet()){if(i++>=snapshotMaxItems)break;out.append('|').append(identityFingerprint(e.getKey())).append('=').append(level>=snapshotMaxDepth?identityFingerprint(e.getValue()):fingerprint(e.getValue(),level+1,seen));}
      return out.toString();
    }
    if (value instanceof Collection<?> collection) {
      out.append("|size=").append(collection.size()); int i=0;
      for(Object item:collection){if(i++>=snapshotMaxItems)break;out.append('|').append(level>=snapshotMaxDepth?identityFingerprint(item):fingerprint(item,level+1,seen));}
      return out.toString();
    }
    if (level >= snapshotMaxDepth || type.getName().startsWith("java.")) return out.append('|').append(identityText(value)).toString();
    int count=0;
    for(Class<?> current=type;current!=null&&current!=Object.class&&count<snapshotMaxFields;current=current.getSuperclass()){
      for(Field field:current.getDeclaredFields()){
        if(Modifier.isStatic(field.getModifiers())||field.isSynthetic()||count++>=snapshotMaxFields)continue;
        out.append('|').append(field.getName()).append('=');
        try{field.setAccessible(true);Object child=field.get(value);out.append(level+1>snapshotMaxDepth?identityFingerprint(child):fingerprint(child,level+1,seen));}
        catch(Throwable error){out.append('<').append(error.getClass().getSimpleName()).append('>');}
      }
    }
    return out.toString();
  }
  private static String identityFingerprint(Object value) {
    if (value == null) return "null";
    if (isScalar(value)) return value.getClass().getName() + ':' + String.valueOf(value);
    return value.getClass().getName() + '@' + System.identityHashCode(value);
  }
  /** Never invokes application toString(); doing so can recursively generate trace events. */
  private static String identityText(Object value) {
    if (value == null) return "null";
    return value.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(value));
  }
  private static String limit(String value, int max) { if (value == null) return ""; return value.length() <= max ? value : value.substring(0, max) + "…"; }

  private static long currentCallId() throws Exception {
    Object value = sharedCalls == null ? null : sharedCalls.get();
    if (!(value instanceof Deque<?> deque) || deque.isEmpty()) return 0L;
    Object call = deque.peek();
    if (call == null) return 0L;
    Field id = callIdField;
    if (id == null || id.getDeclaringClass() != call.getClass()) {
      id = call.getClass().getDeclaredField("id");
      id.setAccessible(true);
      callIdField = id;
    }
    return ((Number) id.get(call)).longValue();
  }

  private static int currentDepth() {
    try {
      Object value = sharedDepth == null ? null : sharedDepth.get();
      return Math.max(0, value instanceof Number ? ((Number) value).intValue() - 1 : 0);
    } catch (Throwable ignored) {
      return 0;
    }
  }

  private static String sourceFile(String className) {
    String top = className == null ? "Unknown" : className.split("\\$", 2)[0];
    int dot = top.lastIndexOf('.');
    return (dot >= 0 ? top.substring(dot + 1) : top) + ".java";
  }

  private static String quote(String value) {
    if (value == null) return "null";
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"")
        .replace("\r", "\\r").replace("\n", "\\n") + "\"";
  }

  private static void installLineTransformer(Instrumentation instrumentation) throws Exception {
    String byteBuddyJar = System.getProperty("cgtl.flow.byteBuddyJar", "").trim();
    if (byteBuddyJar.isEmpty()) throw new IllegalStateException("cgtl.flow.byteBuddyJar was not provided");
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) throw new IllegalStateException("A JDK compiler is required for ordered line replay");

    Path directory = Files.createTempDirectory("cgtl-line-agent-");
    Path source = directory.resolve("local/cgtl/flow/generated/OrderedLineAgent.java");
    Files.createDirectories(source.getParent());
    Files.writeString(source, generatedSource(), StandardCharsets.UTF_8);

    File self = new File(BootstrapAgent.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    String classpath = byteBuddyJar + File.pathSeparator + self.getAbsolutePath();
    int result = compiler.run(null, System.err, System.err,
        "-classpath", classpath,
        "-d", directory.toString(),
        source.toString());
    if (result != 0) throw new IllegalStateException("Ordered line transformer compilation failed with exit code " + result);

    URLClassLoader loader = new URLClassLoader(new URL[]{directory.toUri().toURL()}, ClassLoader.getSystemClassLoader());
    Class<?> generated = Class.forName("local.cgtl.flow.generated.OrderedLineAgent", true, loader);
    generated.getMethod("install", Instrumentation.class).invoke(null, instrumentation);
    System.err.println("[CGTL FLOW] Ordered line replay installed for packages: " + System.getProperty("cgtl.flow.packages", "<all>"));
  }

  private static String generatedSource() {
    return """
      package local.cgtl.flow.generated;

      import java.lang.instrument.Instrumentation;
      import net.bytebuddy.agent.builder.AgentBuilder;
      import net.bytebuddy.asm.AsmVisitorWrapper;
      import net.bytebuddy.description.field.FieldDescription;
      import net.bytebuddy.description.method.MethodList;
      import net.bytebuddy.description.type.TypeDescription;
      import net.bytebuddy.dynamic.DynamicType;
      import net.bytebuddy.implementation.Implementation;
      import net.bytebuddy.jar.asm.ClassReader;
      import net.bytebuddy.jar.asm.ClassVisitor;
      import net.bytebuddy.jar.asm.ClassWriter;
      import net.bytebuddy.jar.asm.Label;
      import net.bytebuddy.jar.asm.MethodVisitor;
      import net.bytebuddy.jar.asm.Opcodes;
      import net.bytebuddy.jar.asm.Type;
      import net.bytebuddy.matcher.ElementMatcher;
      import net.bytebuddy.matcher.ElementMatchers;
      import net.bytebuddy.pool.TypePool;

      public final class OrderedLineAgent {
        public static void install(Instrumentation instrumentation) {
          new AgentBuilder.Default()
              .type(typeMatcher())
              .transform((builder, type, loader, module, domain) -> builder.visit(new Lines()))
              .with(new AgentBuilder.Listener.Adapter() {
                @Override public void onError(String typeName, ClassLoader loader, net.bytebuddy.utility.JavaModule module,
                    boolean loaded, Throwable throwable) {
                  System.err.println("[CGTL FLOW] Line tracing skipped " + typeName + ": " + throwable);
                }
              })
              .installOn(instrumentation);
        }

        private static ElementMatcher.Junction<TypeDescription> typeMatcher() {
          String raw = System.getProperty("cgtl.flow.packages", "").trim();
          ElementMatcher.Junction<TypeDescription> matcher = ElementMatchers.none();
          for (String token : raw.split(",")) {
            String prefix = token.trim();
            if (prefix.endsWith(".*")) prefix = prefix.substring(0, prefix.length() - 2);
            if (prefix.isEmpty()) continue;
            matcher = matcher.or(ElementMatchers.nameStartsWith(prefix + ".")).or(ElementMatchers.named(prefix));
          }
          // Test classes are intentionally included. Ordered replay must begin in
          // the selected test method so its setup and initial call site are visible.
          return matcher
              .and(ElementMatchers.not(ElementMatchers.isInterface()))
              .and(ElementMatchers.not(ElementMatchers.isAnnotation()))
              .and(ElementMatchers.not(ElementMatchers.isSynthetic()));
        }

        private static final class Lines extends AsmVisitorWrapper.AbstractBase {
          @Override public int mergeWriter(int flags) { return flags | ClassWriter.COMPUTE_FRAMES | ClassWriter.COMPUTE_MAXS; }
          @Override public int mergeReader(int flags) { return flags | ClassReader.EXPAND_FRAMES; }

          @Override
          public ClassVisitor wrap(TypeDescription type, ClassVisitor visitor, Implementation.Context context,
              TypePool typePool, net.bytebuddy.description.field.FieldList<FieldDescription.InDefinedShape> fields,
              MethodList<?> methods, int writerFlags, int readerFlags) {
            String className = type.getName();
            return new ClassVisitor(Opcodes.ASM9, visitor) {
              @Override public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                MethodVisitor downstream = super.visitMethod(access, name, descriptor, signature, exceptions);
                if (downstream == null || name.startsWith("<") || isObjectUtility(name, descriptor) ||
                    (access & (Opcodes.ACC_ABSTRACT | Opcodes.ACC_NATIVE | Opcodes.ACC_SYNTHETIC | Opcodes.ACC_BRIDGE)) != 0) return downstream;
                boolean isStatic = (access & Opcodes.ACC_STATIC) != 0;
                return new MethodVisitor(Opcodes.ASM9, downstream) {
                  private int injected;
                  @Override public void visitLineNumber(int line, Label start) {
                    super.visitLineNumber(line, start);
                    if (line <= 0) return;
                    visitLdcInsn(className);
                    visitLdcInsn(name);
                    visitLdcInsn(descriptor);
                    pushInt(this, line);
                    if (isStatic) visitInsn(Opcodes.ACONST_NULL); else visitVarInsn(Opcodes.ALOAD, 0);
                    pushInt(this, 0);
                    visitTypeInsn(Opcodes.ANEWARRAY, "java/lang/String");
                    pushInt(this, 0);
                    visitTypeInsn(Opcodes.ANEWARRAY, "java/lang/Object");
                    visitMethodInsn(Opcodes.INVOKESTATIC, "local/cgtl/flow/BootstrapAgent", "lineState",
                        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ILjava/lang/Object;[Ljava/lang/String;[Ljava/lang/Object;)V", false);
                    injected++;
                  }
                  @Override public void visitEnd() {
                    if (injected > 0) System.err.println("[CGTL FLOW] Line state instrumented " + className + "." + name + "() - " + injected + " lines");
                    super.visitEnd();
                  }
                };
              }
            };
          }

          private static boolean isObjectUtility(String name, String descriptor) {
            return (name.equals("toString") && descriptor.equals("()Ljava/lang/String;"))
                || (name.equals("hashCode") && descriptor.equals("()I"))
                || (name.equals("equals") && descriptor.equals("(Ljava/lang/Object;)Z"));
          }

          private static void pushInt(MethodVisitor visitor, int value) {
            if (value >= -1 && value <= 5) visitor.visitInsn(Opcodes.ICONST_0 + value);
            else if (value <= Byte.MAX_VALUE) visitor.visitIntInsn(Opcodes.BIPUSH, value);
            else if (value <= Short.MAX_VALUE) visitor.visitIntInsn(Opcodes.SIPUSH, value);
            else visitor.visitLdcInsn(value);
          }
        }
      }
      """;
  }
}
