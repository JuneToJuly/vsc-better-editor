package local.cgtl.flow;

import java.io.*;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

public final class FlowAgent {
  public static void premain(String args, Instrumentation inst) {
    try {
      Recorder.initialize();
      ClassLoader loader = ClassLoader.getSystemClassLoader();
      Class<?> builderDefault = Class.forName("net.bytebuddy.agent.builder.AgentBuilder$Default", true, loader);
      Class<?> transformerType = Class.forName("net.bytebuddy.agent.builder.AgentBuilder$Transformer", true, loader);
      Class<?> matchers = Class.forName("net.bytebuddy.matcher.ElementMatchers", true, loader);
      Class<?> advice = Class.forName("net.bytebuddy.asm.Advice", true, loader);
      Object matcher = buildMatcher(matchers);
      Object builder = builderDefault.getConstructor().newInstance();
      Class<?> listenerType = Class.forName("net.bytebuddy.agent.builder.AgentBuilder$Listener", true, loader);
      Object listener = Proxy.newProxyInstance(loader, new Class<?>[]{listenerType}, (proxy, method, values) -> {
        if ("onError".equals(method.getName())) {
          String typeName = values != null && values.length > 0 ? String.valueOf(values[0]) : "<unknown>";
          Throwable error = values != null && values.length > 4 && values[4] instanceof Throwable ? (Throwable) values[4] : null;
          System.err.println("[CGTL FLOW] Skipping " + typeName + " after transformation error: " + error);
          if (error != null) error.printStackTrace(System.err);
        }
        if ("toString".equals(method.getName())) return "CGTL Snapshot Listener";
        if ("hashCode".equals(method.getName())) return System.identityHashCode(proxy);
        if ("equals".equals(method.getName())) return proxy == (values == null ? null : values[0]);
        return null;
      });
      builder = call(builder, "with", listener);
      builder = call(builder, "type", matcher);
      InvocationHandler handler = (proxy, method, values) -> {
        if ("transform".equals(method.getName())) {
          Object dynamicBuilder = values[0];
          String typeName = String.valueOf(values[1]);
          try {
            Object methodMatcher = staticCall(matchers, "isMethod");
            methodMatcher = call(methodMatcher, "and", staticCall(matchers, "not", staticCall(matchers, "isAbstract")));
            methodMatcher = call(methodMatcher, "and", staticCall(matchers, "not", staticCall(matchers, "isNative")));
            methodMatcher = call(methodMatcher, "and", staticCall(matchers, "not", staticCall(matchers, "isSynthetic")));
            methodMatcher = call(methodMatcher, "and", staticCall(matchers, "not", staticCall(matchers, "isBridge")));
            Object visitor = staticCall(advice, "to", MethodAdvice.class);
            Object transformed = call(dynamicBuilder, "visit", call(visitor, "on", methodMatcher));
            System.err.println("[CGTL FLOW] Snapshot tracing " + typeName);
            return transformed;
          } catch (Throwable error) {
            System.err.println("[CGTL FLOW] Skipping " + typeName + " after transformer setup error: " + error);
            error.printStackTrace(System.err);
            return dynamicBuilder;
          }
        }
        if ("toString".equals(method.getName())) return "CGTL Snapshot Transformer";
        if ("hashCode".equals(method.getName())) return System.identityHashCode(proxy);
        if ("equals".equals(method.getName())) return proxy == (values == null ? null : values[0]);
        return null;
      };
      Object transformer = Proxy.newProxyInstance(loader, new Class<?>[]{transformerType}, handler);
      call(call(builder, "transform", transformer), "installOn", inst);
      System.err.println("[CGTL FLOW] Snapshot agent installed for packages: " + System.getProperty("cgtl.flow.packages", "<all>"));
      System.err.println("[CGTL FLOW] Snapshot agent exclusions: " + System.getProperty("cgtl.flow.excludes", "<none>"));
    } catch (Throwable t) {
      System.err.println("[CGTL FLOW] Agent disabled: " + t);
      t.printStackTrace();
    }
  }

  static Object buildMatcher(Class<?> matchers) throws Exception {
    String raw = System.getProperty("cgtl.flow.packages", "").trim();
    Object matcher = staticCall(matchers, "none");
    for (String token : raw.split(",")) {
      String pkg = token.trim();
      if (pkg.isEmpty()) continue;
      matcher = call(matcher, "or", staticCall(matchers, "nameStartsWith", pkg + "."));
      matcher = call(matcher, "or", staticCall(matchers, "named", pkg));
    }
    String excludes = System.getProperty("cgtl.flow.excludes", "").trim();
    Object excluded = staticCall(matchers, "none");
    for (String token : excludes.split(",")) {
      String rule = token.trim();
      if (rule.isEmpty()) continue;
      if (rule.startsWith("package:")) {
        String pkg = rule.substring("package:".length()).trim();
        if (!pkg.isEmpty()) {
          excluded = call(excluded, "or", staticCall(matchers, "nameStartsWith", pkg + "."));
          excluded = call(excluded, "or", staticCall(matchers, "named", pkg));
        }
      } else if (rule.startsWith("class:")) {
        String cls = rule.substring("class:".length()).trim();
        if (!cls.isEmpty()) {
          excluded = call(excluded, "or", staticCall(matchers, "named", cls));
          excluded = call(excluded, "or", staticCall(matchers, "nameStartsWith", cls + "$"));
        }
      }
    }
    matcher = call(matcher, "and", staticCall(matchers, "not", excluded));
    // Test classes within the selected package are intentionally included.
    // This lets ordered replay begin at the actual test line that initiates the call.
    matcher = call(matcher, "and", staticCall(matchers, "not", staticCall(matchers, "isInterface")));
    matcher = call(matcher, "and", staticCall(matchers, "not", staticCall(matchers, "isAnnotation")));
    matcher = call(matcher, "and", staticCall(matchers, "not", staticCall(matchers, "isEnum")));
    matcher = call(matcher, "and", staticCall(matchers, "not", staticCall(matchers, "isRecord")));
    matcher = call(matcher, "and", staticCall(matchers, "not", staticCall(matchers, "isSynthetic")));
    matcher = call(matcher, "and", staticCall(matchers, "not", staticCall(matchers, "isSubTypeOf", Throwable.class)));
    return matcher;
  }
  static Object staticCall(Class<?> type, String name, Object... args) throws Exception { return find(type.getMethods(), name, args).invoke(null, args); }
  static Object call(Object target, String name, Object... args) throws Exception { return find(target.getClass().getMethods(), name, args).invoke(target, args); }
  static Method find(Method[] methods, String name, Object[] args) throws NoSuchMethodException {
    outer: for (Method method : methods) {
      if (!method.getName().equals(name) || method.getParameterCount() != args.length) continue;
      Class<?>[] parameters = method.getParameterTypes();
      for (int i = 0; i < parameters.length; i++) if (args[i] != null && !box(parameters[i]).isAssignableFrom(args[i].getClass())) continue outer;
      return method;
    }
    throw new NoSuchMethodException(name);
  }
  static Class<?> box(Class<?> type) {
    if (!type.isPrimitive()) return type;
    if (type == int.class) return Integer.class; if (type == long.class) return Long.class; if (type == boolean.class) return Boolean.class;
    if (type == byte.class) return Byte.class; if (type == short.class) return Short.class; if (type == char.class) return Character.class;
    if (type == float.class) return Float.class; if (type == double.class) return Double.class; return type;
  }

  public static class MethodAdvice {
    @Advice.OnMethodEnter
    public static long enter(@Advice.Origin("#t") String className,
                             @Advice.Origin("#m") String methodName,
                             @Advice.Origin("#d") String descriptor,
                             @Advice.This(optional = true) Object receiver,
                             @Advice.AllArguments(typing = Assigner.Typing.DYNAMIC) Object[] arguments) {
      return Recorder.enter(className, methodName, descriptor, receiver, arguments);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class)
    public static void exit(@Advice.Enter long callId,
                            @Advice.This(optional = true) Object receiver,
                            @Advice.Return(typing = Assigner.Typing.DYNAMIC) Object returnValue,
                            @Advice.Thrown Throwable thrown) {
      Recorder.exit(callId, receiver, returnValue, thrown);
    }
  }

  public static final class Recorder {
    private static final AtomicLong sequence = new AtomicLong();
    private static final ThreadLocal<Integer> depth = ThreadLocal.withInitial(() -> 0);
    private static final ThreadLocal<Deque<Call>> calls = ThreadLocal.withInitial(ArrayDeque::new);
    private static Writer output;
    private static int maxEvents;
    private static final int snapshotMaxDepth = Integer.getInteger("cgtl.flow.lineState.maxDepth", 2);
    private static final int snapshotMaxFields = Integer.getInteger("cgtl.flow.lineState.maxFields", 30);
    private static final int snapshotMaxItems = Integer.getInteger("cgtl.flow.lineState.maxCollectionItems", 20);

    public static synchronized void initialize() throws Exception {
      String outputPath = System.getProperty("cgtl.flow.output");
      maxEvents = Integer.getInteger("cgtl.flow.maxEvents", 20000);
      if (outputPath == null) return;
      File file = new File(outputPath); File parent = file.getParentFile(); if (parent != null) parent.mkdirs();
      output = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(file, true), StandardCharsets.UTF_8));
      Runtime.getRuntime().addShutdownHook(new Thread(() -> { try { output.close(); } catch (Exception ignored) {} }));
    }

    public static long enter(String className, String methodName, String descriptor, Object receiver, Object[] arguments) {
      long callId = sequence.incrementAndGet();
      int currentDepth = depth.get();
      StackTraceElement caller = findCaller(className, methodName);
      Deque<Call> stack = calls.get();
      Call parentCall = stack.peek();
      String callerReceiver = parentCall == null ? "null" : snapshot(parentCall.receiver, 0, new IdentityHashMap<>());
      String callerArguments = parentCall == null ? "[]" : snapshotArray(parentCall.arguments, new IdentityHashMap<>());
      stack.push(new Call(callId, className, methodName, descriptor, caller, receiver, arguments));
      depth.set(currentDepth + 1);
      write("{\"sequence\":" + callId + ",\"event\":\"enter\",\"callId\":" + callId +
        ",\"className\":" + quote(className) + ",\"methodName\":" + quote(methodName) + ",\"descriptor\":" + quote(descriptor) +
        ",\"depth\":" + currentDepth + ",\"threadId\":" + Thread.currentThread().getId() +
        ",\"threadName\":" + quote(Thread.currentThread().getName()) + callerJson(caller) + ",\"callerReceiver\":" + callerReceiver + ",\"callerArguments\":" + callerArguments + ",\"receiver\":" + snapshot(receiver, 0, new IdentityHashMap<>()) +
        ",\"arguments\":" + snapshotArray(arguments, new IdentityHashMap<>()) + "}");
      return callId;
    }

    public static void exit(long callId, Object receiverAfter, Object returnValue, Throwable thrown) {
      int currentDepth = Math.max(0, depth.get() - 1); depth.set(currentDepth);
      Deque<Call> stack = calls.get();
      Call call = stack.poll();
      Call parentCall = stack.peek();
      long eventId = sequence.incrementAndGet();
      String className = call == null ? "" : call.className; String methodName = call == null ? "" : call.methodName; String descriptor = call == null ? "" : call.descriptor;
      String callerReceiverAfter = parentCall == null ? "null" : snapshot(parentCall.receiver, 0, new IdentityHashMap<>());
      String callerArgumentsAfter = parentCall == null ? "[]" : snapshotArray(parentCall.arguments, new IdentityHashMap<>());
      IdentityHashMap<Object, Boolean> seen = new IdentityHashMap<>();
      write("{\"sequence\":" + eventId + ",\"event\":\"exit\",\"callId\":" + callId +
        ",\"className\":" + quote(className) + ",\"methodName\":" + quote(methodName) + ",\"descriptor\":" + quote(descriptor) +
        ",\"depth\":" + currentDepth + ",\"threadId\":" + Thread.currentThread().getId() + ",\"threadName\":" + quote(Thread.currentThread().getName()) +
        ",\"receiverAfter\":" + snapshot(receiverAfter, 0, new IdentityHashMap<>()) +
        ",\"callerReceiverAfter\":" + callerReceiverAfter +
        ",\"callerArgumentsAfter\":" + callerArgumentsAfter +
        ",\"returnValue\":" + snapshot(returnValue, 0, seen) + ",\"thrown\":" + throwableSnapshot(thrown) + callerJson(call == null ? null : call.caller) + "}");
    }

    private static StackTraceElement findCaller(String className, String methodName) {
      StackTraceElement[] frames = Thread.currentThread().getStackTrace();
      for (int i = 0; i < frames.length - 1; i++) {
        StackTraceElement frame = frames[i];
        if (className.equals(frame.getClassName()) && methodName.equals(frame.getMethodName())) {
          return frames[i + 1];
        }
      }
      return null;
    }

    private static String callerJson(StackTraceElement caller) {
      if (caller == null) return "";
      return ",\"callerClassName\":" + quote(caller.getClassName()) +
        ",\"callerMethodName\":" + quote(caller.getMethodName()) +
        ",\"callerSourceFile\":" + quote(caller.getFileName()) +
        ",\"callerLine\":" + caller.getLineNumber();
    }

    private static synchronized void write(String json) {
      try { if (output != null && sequence.get() <= maxEvents) { output.write(json); output.write("\n"); output.flush(); } } catch (Exception ignored) {}
    }

    public static String snapshotForLine(Object value) {
      try { return snapshot(value, 0, new IdentityHashMap<>()); }
      catch (Throwable error) { return "{\"type\":\"unavailable\",\"value\":" + quote("<" + error.getClass().getSimpleName() + ">") + "}"; }
    }

    private static String snapshotArray(Object[] values, IdentityHashMap<Object, Boolean> seen) {
      if (values == null) return "[]"; StringBuilder result = new StringBuilder("[");
      for (int i = 0; i < values.length; i++) { if (i > 0) result.append(','); result.append(snapshot(values[i], 0, seen)); }
      return result.append(']').toString();
    }

    private static String snapshot(Object value, int level, IdentityHashMap<Object, Boolean> seen) {
      if (value == null) return "null";
      if (value instanceof String || value instanceof Character || value instanceof Enum<?>) return "{\"type\":" + quote(value.getClass().getName()) + ",\"value\":" + quote(limit(String.valueOf(value), 500)) + "}";
      if (value instanceof Number || value instanceof Boolean) return "{\"type\":" + quote(value.getClass().getName()) + ",\"value\":" + quote(String.valueOf(value)) + "}";
      Class<?> type = value.getClass();
      if (type.isArray()) { int total = Array.getLength(value); int length = Math.min(total, snapshotMaxItems); StringBuilder out = new StringBuilder("{\"type\":" + quote(type.getName()) + ",\"items\":["); for (int i=0;i<length;i++){if(i>0)out.append(',');out.append(snapshot(Array.get(value,i),level+1,seen));} return out.append("],\"size\":").append(total).append('}').toString(); }
      if (seen.put(value, Boolean.TRUE) != null) return "{\"type\":" + quote(type.getName()) + ",\"value\":\"<cycle>\"}";
      if (value instanceof Map<?,?> map) { StringBuilder out = new StringBuilder("{\"type\":" + quote(type.getName()) + ",\"entries\":["); int i=0; for (Map.Entry<?,?> entry : map.entrySet()) { if (i++ >= snapshotMaxItems) break; if (i > 1) out.append(','); out.append("{\"key\":").append(snapshot(entry.getKey(), level+1, seen)).append(",\"value\":").append(snapshot(entry.getValue(), level+1, seen)).append('}'); } return out.append("],\"size\":").append(map.size()).append('}').toString(); }
      if (value instanceof Collection<?> collection) { StringBuilder out = new StringBuilder("{\"type\":" + quote(type.getName()) + ",\"items\":["); int i=0; for (Object item : collection) { if (i++ >= snapshotMaxItems) break; if (i > 1) out.append(','); out.append(snapshot(item, level+1, seen)); } return out.append("],\"size\":").append(collection.size()).append('}').toString(); }
      if (level >= snapshotMaxDepth) return "{\"type\":" + quote(type.getName()) + ",\"value\":" + quote(identityText(value)) + "}";
      StringBuilder fields = new StringBuilder(); int count = 0;
      for (Class<?> current = type; current != null && current != Object.class && count < snapshotMaxFields; current = current.getSuperclass()) {
        for (Field field : current.getDeclaredFields()) {
          if (Modifier.isStatic(field.getModifiers()) || field.isSynthetic() || count >= snapshotMaxFields) continue;
          if (count++ > 0) fields.append(',');
          fields.append(quote(field.getName())).append(':');
          try { field.setAccessible(true); fields.append(snapshot(field.get(value), level + 1, seen)); }
          catch (Throwable error) { fields.append("{\"type\":\"unavailable\",\"value\":" + quote("<" + error.getClass().getSimpleName() + ">") + "}"); }
        }
      }
      return "{\"type\":" + quote(type.getName()) + ",\"value\":" + quote(identityText(value)) + ",\"fields\":{" + fields + "}}";
    }

    private static String throwableSnapshot(Throwable thrown) {
      if (thrown == null) return "null";
      return "{\"type\":" + quote(thrown.getClass().getName()) + ",\"message\":" + quote(limit(thrown.getMessage(), 1000)) + "}";
    }
    private static String identityText(Object value) {
      if (value == null) return "null";
      return value.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(value));
    }
    private static String limit(String value, int max) { if (value == null) return ""; return value.length() <= max ? value : value.substring(0, max) + "…"; }
    private static String quote(String value) { if (value == null) return "null"; return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\r", "\\r").replace("\n", "\\n") + "\""; }
    private static final class Call { final long id; final String className, methodName, descriptor; final StackTraceElement caller; final Object receiver; final Object[] arguments; Call(long id,String c,String m,String d,StackTraceElement caller,Object receiver,Object[] arguments){this.id=id;this.className=c;this.methodName=m;this.descriptor=d;this.caller=caller;this.receiver=receiver;this.arguments=arguments == null ? new Object[0] : arguments.clone();} }
  }
}
