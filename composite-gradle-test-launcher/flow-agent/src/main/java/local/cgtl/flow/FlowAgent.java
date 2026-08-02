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
      Object builder = call(builderDefault.getConstructor().newInstance(), "type", matcher);
      InvocationHandler handler = (proxy, method, values) -> {
        if ("transform".equals(method.getName())) {
          Object dynamicBuilder = values[0];
          String typeName = String.valueOf(values[1]);
          Object methodMatcher = staticCall(matchers, "isMethod");
          methodMatcher = call(methodMatcher, "and", staticCall(matchers, "not", staticCall(matchers, "isAbstract")));
          methodMatcher = call(methodMatcher, "and", staticCall(matchers, "not", staticCall(matchers, "isNative")));
          Object visitor = staticCall(advice, "to", MethodAdvice.class);
          System.err.println("[CGTL FLOW] Snapshot tracing " + typeName);
          return call(dynamicBuilder, "visit", call(visitor, "on", methodMatcher));
        }
        if ("toString".equals(method.getName())) return "CGTL Snapshot Transformer";
        if ("hashCode".equals(method.getName())) return System.identityHashCode(proxy);
        if ("equals".equals(method.getName())) return proxy == (values == null ? null : values[0]);
        return null;
      };
      Object transformer = Proxy.newProxyInstance(loader, new Class<?>[]{transformerType}, handler);
      call(call(builder, "transform", transformer), "installOn", inst);
      System.err.println("[CGTL FLOW] Snapshot agent installed for packages: " + System.getProperty("cgtl.flow.packages", "<all>"));
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
    Object tests = staticCall(matchers, "nameMatches", ".*(?:Test|Tests|IT|ITCase)$");
    return call(matcher, "and", staticCall(matchers, "not", tests));
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
                            @Advice.Return(typing = Assigner.Typing.DYNAMIC) Object returnValue,
                            @Advice.Thrown Throwable thrown) {
      Recorder.exit(callId, returnValue, thrown);
    }
  }

  public static final class Recorder {
    private static final AtomicLong sequence = new AtomicLong();
    private static final ThreadLocal<Integer> depth = ThreadLocal.withInitial(() -> 0);
    private static final ThreadLocal<Deque<Call>> calls = ThreadLocal.withInitial(ArrayDeque::new);
    private static Writer output;
    private static int maxEvents;

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
      calls.get().push(new Call(callId, className, methodName, descriptor));
      depth.set(currentDepth + 1);
      write("{\"sequence\":" + callId + ",\"event\":\"enter\",\"callId\":" + callId +
        ",\"className\":" + quote(className) + ",\"methodName\":" + quote(methodName) + ",\"descriptor\":" + quote(descriptor) +
        ",\"depth\":" + currentDepth + ",\"threadId\":" + Thread.currentThread().getId() +
        ",\"threadName\":" + quote(Thread.currentThread().getName()) + ",\"receiver\":" + snapshot(receiver, 0, new IdentityHashMap<>()) +
        ",\"arguments\":" + snapshotArray(arguments, new IdentityHashMap<>()) + "}");
      return callId;
    }

    public static void exit(long callId, Object returnValue, Throwable thrown) {
      int currentDepth = Math.max(0, depth.get() - 1); depth.set(currentDepth);
      Call call = calls.get().poll(); long eventId = sequence.incrementAndGet();
      String className = call == null ? "" : call.className; String methodName = call == null ? "" : call.methodName; String descriptor = call == null ? "" : call.descriptor;
      IdentityHashMap<Object, Boolean> seen = new IdentityHashMap<>();
      write("{\"sequence\":" + eventId + ",\"event\":\"exit\",\"callId\":" + callId +
        ",\"className\":" + quote(className) + ",\"methodName\":" + quote(methodName) + ",\"descriptor\":" + quote(descriptor) +
        ",\"depth\":" + currentDepth + ",\"threadId\":" + Thread.currentThread().getId() + ",\"threadName\":" + quote(Thread.currentThread().getName()) +
        ",\"returnValue\":" + snapshot(returnValue, 0, seen) + ",\"thrown\":" + throwableSnapshot(thrown) + "}");
    }

    private static synchronized void write(String json) {
      try { if (output != null && sequence.get() <= maxEvents) { output.write(json); output.write("\n"); output.flush(); } } catch (Exception ignored) {}
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
      if (type.isArray()) { int length = Math.min(Array.getLength(value), 20); StringBuilder out = new StringBuilder("{\"type\":" + quote(type.getName()) + ",\"items\":["); for (int i=0;i<length;i++){if(i>0)out.append(',');out.append(snapshot(Array.get(value,i),level+1,seen));} return out.append("]}").toString(); }
      if (seen.put(value, Boolean.TRUE) != null) return "{\"type\":" + quote(type.getName()) + ",\"value\":\"<cycle>\"}";
      if (level >= 2) return "{\"type\":" + quote(type.getName()) + ",\"value\":" + quote(safeText(value)) + "}";
      StringBuilder fields = new StringBuilder(); int count = 0;
      for (Class<?> current = type; current != null && current != Object.class && count < 30; current = current.getSuperclass()) {
        for (Field field : current.getDeclaredFields()) {
          if (Modifier.isStatic(field.getModifiers()) || field.isSynthetic() || count >= 30) continue;
          if (count++ > 0) fields.append(',');
          fields.append(quote(field.getName())).append(':');
          try { field.setAccessible(true); fields.append(snapshot(field.get(value), level + 1, seen)); }
          catch (Throwable error) { fields.append("{\"type\":\"unavailable\",\"value\":" + quote("<" + error.getClass().getSimpleName() + ">") + "}"); }
        }
      }
      return "{\"type\":" + quote(type.getName()) + ",\"value\":" + quote(safeText(value)) + ",\"fields\":{" + fields + "}}";
    }

    private static String throwableSnapshot(Throwable thrown) {
      if (thrown == null) return "null";
      return "{\"type\":" + quote(thrown.getClass().getName()) + ",\"message\":" + quote(limit(thrown.getMessage(), 1000)) + "}";
    }
    private static String safeText(Object value) { try { return limit(String.valueOf(value), 500); } catch (Throwable ignored) { return "<toString failed>"; } }
    private static String limit(String value, int max) { if (value == null) return ""; return value.length() <= max ? value : value.substring(0, max) + "…"; }
    private static String quote(String value) { if (value == null) return "null"; return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\r", "\\r").replace("\n", "\\n") + "\""; }
    private static final class Call { final long id; final String className, methodName, descriptor; Call(long id,String c,String m,String d){this.id=id;this.className=c;this.methodName=m;this.descriptor=d;} }
  }
}
