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

  private BootstrapAgent() {}

  public static void premain(String args, Instrumentation instrumentation) {
    try {
      Class<?> flowAgent = Class.forName("local.cgtl.flow.FlowAgent", true, ClassLoader.getSystemClassLoader());
      Method premain = flowAgent.getMethod("premain", String.class, Instrumentation.class);
      premain.invoke(null, args, instrumentation);
      bindRecorder(flowAgent);
      consoleLines = Boolean.parseBoolean(System.getProperty("cgtl.flow.consoleLines", "true"));
      System.err.println("[CGTL FLOW] Line state validation mode=" + System.getProperty("cgtl.flow.lineState", "receiver"));
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
    try { return snapshot(value, 0, new IdentityHashMap<>()); }
    catch (Throwable error) { return "{\"type\":\"unavailable\",\"value\":" + quote("<" + error.getClass().getSimpleName() + ">") + "}"; }
  }

  private static String snapshot(Object value, int level, IdentityHashMap<Object, Boolean> seen) {
    if (value == null) return "null";
    if (value instanceof String || value instanceof Character || value instanceof Enum<?>) return "{\"type\":" + quote(value.getClass().getName()) + ",\"value\":" + quote(limit(String.valueOf(value), 500)) + "}";
    if (value instanceof Number || value instanceof Boolean) return "{\"type\":" + quote(value.getClass().getName()) + ",\"value\":" + quote(String.valueOf(value)) + "}";
    Class<?> type = value.getClass();
    if (type.isArray()) {
      int length = Math.min(Array.getLength(value), 20); StringBuilder out = new StringBuilder("{\"type\":" + quote(type.getName()) + ",\"items\":[");
      for (int i=0;i<length;i++){if(i>0)out.append(',');out.append(snapshot(Array.get(value,i),level+1,seen));}
      return out.append("]}").toString();
    }
    if (seen.put(value, Boolean.TRUE) != null) return "{\"type\":" + quote(type.getName()) + ",\"value\":\"<cycle>\"}";
    if (level >= 1) return "{\"type\":" + quote(type.getName()) + ",\"value\":" + quote(safeText(value)) + "}";
    StringBuilder fields = new StringBuilder(); int count = 0;
    for (Class<?> current = type; current != null && current != Object.class && count < 25; current = current.getSuperclass()) {
      for (Field field : current.getDeclaredFields()) {
        if (Modifier.isStatic(field.getModifiers()) || field.isSynthetic() || count >= 25) continue;
        if (count++ > 0) fields.append(','); fields.append(quote(field.getName())).append(':');
        try { field.setAccessible(true); fields.append(snapshot(field.get(value), level + 1, seen)); }
        catch (Throwable error) { fields.append("{\"type\":\"unavailable\",\"value\":" + quote("<" + error.getClass().getSimpleName() + ">") + "}"); }
      }
    }
    return "{\"type\":" + quote(type.getName()) + ",\"value\":" + quote(safeText(value)) + ",\"fields\":{" + fields + "}}";
  }
  private static String safeText(Object value) { try { return limit(String.valueOf(value), 500); } catch (Throwable ignored) { return "<toString failed>"; } }
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
                if (downstream == null || name.startsWith("<") ||
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
