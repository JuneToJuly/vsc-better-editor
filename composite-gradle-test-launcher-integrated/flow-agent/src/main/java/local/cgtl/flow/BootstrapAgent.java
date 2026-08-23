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
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.HashSet;
import java.util.concurrent.ConcurrentHashMap;
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
  public static final Object UNSET_LOCAL = new Object();
  private static final IdentityHashMap<Object, SnapshotCacheEntry> snapshotCache = new IdentityHashMap<>();
  private static final AtomicLong snapshotIds = new AtomicLong();
  private static final int snapshotMaxDepth = Integer.getInteger("cgtl.flow.lineState.maxDepth", 2);
  private static final int snapshotMaxFields = Integer.getInteger("cgtl.flow.lineState.maxFields", 30);
  private static final int snapshotMaxItems = Integer.getInteger("cgtl.flow.lineState.maxCollectionItems", 20);
  private static final int capturePointMaxDepth = Integer.getInteger("cgtl.flow.capturePoint.maxDepth", 8);
  private static final int capturePointMaxFields = Integer.getInteger("cgtl.flow.capturePoint.maxFields", 200);
  private static final int capturePointMaxItems = Integer.getInteger("cgtl.flow.capturePoint.maxCollectionItems", 200);
  private static final Set<String> capturePoints = parseCapturePoints(System.getProperty("cgtl.flow.capturePoints", ""));
  private static final ConcurrentHashMap<String, List<LocalScope>> localScopes = new ConcurrentHashMap<>();

  private static final class LocalScope {
    final String name; final int slot; final int startLine; final int endLine;
    LocalScope(String name, int slot, int startLine, int endLine) {
      this.name = name; this.slot = slot; this.startLine = startLine; this.endLine = endLine;
    }
  }

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
      System.err.println("[CGTL FLOW] Capture points=" + (capturePoints.isEmpty() ? "<none>" : capturePoints)
          + " maxDepth=" + capturePointMaxDepth
          + " maxFields=" + capturePointMaxFields
          + " maxItems=" + capturePointMaxItems);
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
      boolean capturePoint = isCapturePoint(className, line);
      String receiverJson = capturePoint ? deepSnapshotForCapturePoint(receiver) : snapshotForLine(receiver);
      String localsJson = capturePoint
          ? deepLocalsJson(className, methodName, descriptor, line, localNames, localValues)
          : localsJson(className, methodName, descriptor, line, localNames, localValues);
      String json = "{\"sequence\":" + eventSequence +
          ",\"event\":\"line\"" +
          ",\"capturePoint\":" + capturePoint +
          (capturePoint ? ",\"capturePointDepth\":" + capturePointMaxDepth : "") +
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
          ",\"frameReceiver\":" + receiverJson +
          ",\"frameLocals\":" + localsJson + "}";
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

  public static void registerLocalNames(String className, String methodName, String descriptor,
      String[] names, int[] slots, int[] startLines, int[] endLines) {
    if (names == null || slots == null) return;
    List<LocalScope> scopes = new ArrayList<>();
    for (int i = 0; i < names.length && i < slots.length; i++) {
      String name = names[i];
      if (name == null || name.isBlank() || "this".equals(name)) continue;
      int start = startLines != null && i < startLines.length ? startLines[i] : 0;
      int end = endLines != null && i < endLines.length ? endLines[i] : Integer.MAX_VALUE;
      scopes.add(new LocalScope(name, slots[i], start, end));
    }
    localScopes.put(methodKey(className, methodName, descriptor), scopes);
  }

  private static String localName(String className, String methodName, String descriptor, int line, int slot) {
    List<LocalScope> scopes = localScopes.get(methodKey(className, methodName, descriptor));
    if (scopes == null) return null;
    LocalScope best = null;
    for (LocalScope scope : scopes) {
      if (scope.slot != slot || line < scope.startLine || line >= scope.endLine) continue;
      if (best == null || scope.startLine >= best.startLine) best = scope;
    }
    return best == null ? null : best.name;
  }

  private static String methodKey(String className, String methodName, String descriptor) {
    return className + "#" + methodName + descriptor;
  }

  private static Set<String> parseCapturePoints(String raw) {
    Set<String> result = new HashSet<>();
    if (raw == null || raw.isBlank()) return result;
    for (String value : raw.split(",")) {
      String trimmed = value == null ? "" : value.trim();
      int hash = trimmed.lastIndexOf('#');
      if (hash <= 0 || hash >= trimmed.length() - 1) continue;
      try {
        int line = Integer.parseInt(trimmed.substring(hash + 1));
        if (line > 0) result.add(trimmed.substring(0, hash) + "#" + line);
      } catch (NumberFormatException ignored) { }
    }
    return result;
  }

  private static boolean isCapturePoint(String className, int line) {
    if (capturePoints.isEmpty() || className == null || line <= 0) return false;
    if (capturePoints.contains(className + "#" + line)) return true;
    int nested = className.indexOf('$');
    return nested > 0 && capturePoints.contains(className.substring(0, nested) + "#" + line);
  }

  private static String deepLocalsJson(String className, String methodName, String descriptor, int line,
      String[] names, Object[] values) {
    if (values == null) return "{}";
    StringBuilder out = new StringBuilder("{");
    int emitted = 0;
    for (int i = 0; i < values.length; i++) {
      Object value = values[i];
      if (value == UNSET_LOCAL) continue;
      String name = names != null && i < names.length && names[i] != null && !names[i].isBlank()
          ? names[i]
          : localName(className, methodName, descriptor, line, i);
      if (name == null || name.isBlank()) continue;
      if (emitted++ > 0) out.append(',');
      out.append(quote(name)).append(':').append(deepSnapshotForCapturePoint(value));
    }
    return out.append('}').toString();
  }

  private static String deepSnapshotForCapturePoint(Object value) {
    try { return deepSnapshot(value, 0, new IdentityHashMap<>()); }
    catch (Throwable error) {
      return "{\"type\":\"unavailable\",\"value\":" + quote("<" + error.getClass().getSimpleName() + ">") + "}";
    }
  }

  /**
   * High-fidelity snapshot used only at explicit Replay capture points. Unlike the
   * normal line snapshot, this does not collapse unchanged objects into snapshotRef
   * records: the capture point must be self-contained when inspected later.
   */
  private static String deepSnapshot(Object value, int level, IdentityHashMap<Object, Boolean> seen) {
    if (value == null) return "null";
    if (isScalar(value)) return scalarSnapshot(value);
    Class<?> type = value.getClass();

    // Depth is a strict object-graph boundary. At depth N, nested values at
    // level N are represented only by a compact identity summary; containers
    // and adapters must not bypass the boundary by expanding their contents.
    if (level >= capturePointMaxDepth) {
      return "{\"type\":" + quote(type.getName()) + ",\"value\":" + quote(identityText(value)) + ",\"truncated\":true}";
    }

    SnapshotAdapters.Adapted adapted = SnapshotAdapters.adapt(value);
    if (adapted != null) {
      Object adaptedValue = SnapshotAdapters.sanitizedAdapterValue(adapted);
      StringBuilder out = new StringBuilder("{\"type\":").append(quote(type.getName()))
          .append(",\"adapter\":").append(quote(adapted.adapter));
      if (adapted.display != null) out.append(",\"value\":").append(quote(limit(adapted.display, 1000)));
      if (adaptedValue instanceof Map<?,?> map) {
        out.append(",\"fields\":").append(deepStructuredMap(map, level + 1, seen));
      } else if (adaptedValue instanceof Collection<?> collection) {
        out.append(",\"items\":").append(deepStructuredCollection(collection, level + 1, seen))
            .append(",\"size\":").append(collection.size());
      } else if (adaptedValue != null && adaptedValue.getClass().isArray()) {
        out.append(",\"items\":").append(deepStructuredArray(adaptedValue, level + 1, seen))
            .append(",\"size\":").append(Array.getLength(adaptedValue));
      }
      return out.append('}').toString();
    }

    if (seen.put(value, Boolean.TRUE) != null) {
      return "{\"type\":" + quote(type.getName()) + ",\"value\":" + quote("<cycle " + identityText(value) + ">") + "}";
    }

    if (type.isArray()) {
      int total = Array.getLength(value);
      int count = Math.min(total, capturePointMaxItems);
      StringBuilder items = new StringBuilder("[");
      for (int i = 0; i < count; i++) {
        if (i > 0) items.append(',');
        items.append(deepSnapshot(Array.get(value, i), level + 1, seen));
      }
      return "{\"type\":" + quote(type.getName()) + ",\"items\":" + items.append(']') + ",\"size\":" + total
          + (total > count ? ",\"truncated\":true" : "") + "}";
    }

    if (value instanceof Map<?,?> map) {
      StringBuilder entries = new StringBuilder("[");
      int i = 0;
      for (Map.Entry<?,?> entry : map.entrySet()) {
        if (i >= capturePointMaxItems) break;
        if (i++ > 0) entries.append(',');
        entries.append("{\"key\":").append(deepSnapshot(entry.getKey(), level + 1, seen))
            .append(",\"value\":").append(deepSnapshot(entry.getValue(), level + 1, seen)).append('}');
      }
      return "{\"type\":" + quote(type.getName()) + ",\"entries\":" + entries.append(']') + ",\"size\":" + map.size()
          + (map.size() > i ? ",\"truncated\":true" : "") + "}";
    }

    if (value instanceof Collection<?> collection) {
      StringBuilder items = new StringBuilder("[");
      int i = 0;
      for (Object item : collection) {
        if (i >= capturePointMaxItems) break;
        if (i++ > 0) items.append(',');
        items.append(deepSnapshot(item, level + 1, seen));
      }
      return "{\"type\":" + quote(type.getName()) + ",\"items\":" + items.append(']') + ",\"size\":" + collection.size()
          + (collection.size() > i ? ",\"truncated\":true" : "") + "}";
    }

    // Unknown JDK internals remain opaque unless a safe semantic adapter handles them.
    if (type.getName().startsWith("java.")) {
      return "{\"type\":" + quote(type.getName()) + ",\"value\":" + quote(identityText(value)) + "}";
    }

    StringBuilder fields = new StringBuilder("{");
    int count = 0;
    boolean truncated = false;
    outer:
    for (Class<?> current = type; current != null && current != Object.class; current = current.getSuperclass()) {
      for (Field field : current.getDeclaredFields()) {
        if (Modifier.isStatic(field.getModifiers()) || field.isSynthetic()) continue;
        if (count >= capturePointMaxFields) { truncated = true; break outer; }
        if (count++ > 0) fields.append(',');
        fields.append(quote(field.getName())).append(':');
        try {
          field.setAccessible(true);
          fields.append(deepSnapshot(field.get(value), level + 1, seen));
        } catch (Throwable error) {
          fields.append("{\"type\":\"unavailable\",\"value\":").append(quote("<" + error.getClass().getSimpleName() + ">")).append('}');
        }
      }
    }
    return "{\"type\":" + quote(type.getName()) + ",\"value\":" + quote(identityText(value))
        + ",\"fields\":" + fields.append('}')
        + (truncated ? ",\"truncated\":true" : "") + "}";
  }

  private static String deepStructuredMap(Map<?,?> map, int level, IdentityHashMap<Object, Boolean> seen) {
    StringBuilder out = new StringBuilder("{");
    int i = 0;
    for (Map.Entry<?,?> entry : map.entrySet()) {
      if (i >= capturePointMaxFields) break;
      if (i++ > 0) out.append(',');
      out.append(quote(String.valueOf(entry.getKey()))).append(':').append(deepSnapshot(entry.getValue(), level, seen));
    }
    return out.append('}').toString();
  }

  private static String deepStructuredCollection(Collection<?> collection, int level, IdentityHashMap<Object, Boolean> seen) {
    StringBuilder out = new StringBuilder("[");
    int i = 0;
    for (Object item : collection) {
      if (i >= capturePointMaxItems) break;
      if (i++ > 0) out.append(',');
      out.append(deepSnapshot(item, level, seen));
    }
    return out.append(']').toString();
  }

  private static String deepStructuredArray(Object array, int level, IdentityHashMap<Object, Boolean> seen) {
    StringBuilder out = new StringBuilder("[");
    int count = Math.min(Array.getLength(array), capturePointMaxItems);
    for (int i = 0; i < count; i++) {
      if (i > 0) out.append(',');
      out.append(deepSnapshot(Array.get(array, i), level, seen));
    }
    return out.append(']').toString();
  }

  private static String localsJson(String className, String methodName, String descriptor, int line,
      String[] names, Object[] values) {
    if (values == null) return "{}";
    StringBuilder out = new StringBuilder("{");
    int emitted = 0;
    for (int i = 0; i < values.length; i++) {
      Object value = values[i];
      if (value == UNSET_LOCAL) continue;
      String name = names != null && i < names.length && names[i] != null && !names[i].isBlank()
          ? names[i]
          : localName(className, methodName, descriptor, line, i);
      // Never expose compiler/JVM slots as source locals. If debug metadata cannot
      // prove the source name and scope, omit the value rather than mislabel it.
      if (name == null || name.isBlank()) continue;
      if (emitted++ > 0) out.append(',');
      out.append(quote(name)).append(':').append(snapshotForLine(value));
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

    // Root values still expose their direct structure, but nested values at
    // the configured depth are summaries only. This makes maxDepth strict for
    // ordinary objects, Maps, Collections, arrays, and adapter-backed values.
    if (!forceRoot && level >= snapshotMaxDepth) return summary(value);

    SnapshotAdapters.Adapted adapted = SnapshotAdapters.adapt(value);
    if (adapted != null) return adaptedSnapshot(value, type, adapted, level, seen, forceRoot);
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
        out.append(snapshot(Array.get(value, i), level + 1, seen, false));
      }
      body = "\"items\":" + out.append(']').toString() + ",\"size\":" + Array.getLength(value);
    } else if (value instanceof Map<?,?> map) {
      StringBuilder out = new StringBuilder("["); int i = 0;
      for (Map.Entry<?,?> entry : map.entrySet()) {
        if (i++ >= snapshotMaxItems) break;
        if (i > 1) out.append(',');
        out.append("{\"key\":").append(snapshot(entry.getKey(), level + 1, seen, false));
        out.append(",\"value\":").append(snapshot(entry.getValue(), level + 1, seen, false)).append('}');
      }
      body = "\"entries\":" + out.append(']').toString() + ",\"size\":" + map.size();
    } else if (value instanceof Collection<?> collection) {
      StringBuilder out = new StringBuilder("["); int i = 0;
      for (Object item : collection) {
        if (i++ >= snapshotMaxItems) break;
        if (i > 1) out.append(',');
        out.append(snapshot(item, level + 1, seen, false));
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
            fields.append(snapshot(child, level + 1, seen, false));
          } catch (Throwable error) {
            fields.append("{\"type\":\"unavailable\",\"value\":" + quote("<" + error.getClass().getSimpleName() + ">") + "}");
          }
        }
      }
      body = "\"value\":" + quote(identityText(value)) + ",\"fields\":{" + fields + "}";
    }
    return "{\"snapshotId\":" + quote(cache.id) + ",\"checkpointSequence\":" + cache.checkpointSequence + ",\"type\":" + quote(type.getName()) + "," + body + "}";
  }


  private static String adaptedSnapshot(Object original, Class<?> type, SnapshotAdapters.Adapted adapted, int level, IdentityHashMap<Object, Boolean> seen, boolean forceRoot) {
    SnapshotCacheEntry cache = cacheEntry(original, type);
    Object adaptedValue = SnapshotAdapters.sanitizedAdapterValue(adapted);
    String fingerprint = "adapter:" + adapted.adapter + ":" + structuredFingerprint(adaptedValue, level, new IdentityHashMap<>());
    boolean unchanged = !forceRoot && fingerprint.equals(cache.fingerprint);
    if (unchanged) return refSnapshot(cache, type, "unchanged");
    cache.fingerprint = fingerprint;
    cache.checkpointSequence = sharedSequence == null ? 0 : sharedSequence.get();
    StringBuilder out = new StringBuilder("{\"snapshotId\":").append(quote(cache.id))
        .append(",\"checkpointSequence\":").append(cache.checkpointSequence)
        .append(",\"type\":").append(quote(type.getName()))
        .append(",\"adapter\":").append(quote(adapted.adapter));
    if (adapted.display != null) out.append(",\"value\":").append(quote(limit(adapted.display, 500)));
    if (adaptedValue instanceof Map<?,?> map) {
      out.append(",\"fields\":").append(structuredJson(map, level + 1, seen));
    } else if (adaptedValue instanceof Collection<?> || (adaptedValue != null && adaptedValue.getClass().isArray())) {
      out.append(",\"items\":").append(structuredJson(adaptedValue, level + 1, seen));
    } else if (adapted.display == null) {
      out.append(",\"value\":").append(structuredJson(adaptedValue, level + 1, seen));
    }
    return out.append('}').toString();
  }

  private static String structuredJson(Object value, int level, IdentityHashMap<Object, Boolean> seen) {
    if (value == null) return "null";
    if (SnapshotAdapters.isSimple(value)) return scalarSnapshot(value);
    if (level > snapshotMaxDepth + 2) return summary(value);
    if (value instanceof Map<?,?> map) {
      StringBuilder out = new StringBuilder("{"); int i = 0;
      for (Map.Entry<?,?> entry : map.entrySet()) {
        if (i++ >= snapshotMaxFields) break;
        if (i > 1) out.append(',');
        out.append(quote(String.valueOf(entry.getKey()))).append(':').append(structuredJson(entry.getValue(), level + 1, seen));
      }
      return out.append('}').toString();
    }
    if (value instanceof Collection<?> collection) {
      StringBuilder out = new StringBuilder("["); int i = 0;
      for (Object item : collection) { if (i++ >= snapshotMaxItems) break; if (i > 1) out.append(','); out.append(structuredJson(item, level + 1, seen)); }
      return out.append(']').toString();
    }
    if (value.getClass().isArray()) {
      StringBuilder out = new StringBuilder("["); int n = Math.min(Array.getLength(value), snapshotMaxItems);
      for (int i = 0; i < n; i++) { if (i > 0) out.append(','); out.append(structuredJson(Array.get(value, i), level + 1, seen)); }
      return out.append(']').toString();
    }
    return snapshot(value, level, seen, false);
  }

  private static String structuredFingerprint(Object value, int level, IdentityHashMap<Object, Boolean> seen) {
    if (value == null) return "null";
    if (SnapshotAdapters.isSimple(value)) return value.getClass().getName() + ':' + String.valueOf(value);
    if (seen.put(value, Boolean.TRUE) != null) return "cycle@" + System.identityHashCode(value);
    if (value instanceof Map<?,?> map) {
      StringBuilder out = new StringBuilder("map"); int i = 0;
      for (Map.Entry<?,?> entry : map.entrySet()) { if (i++ >= snapshotMaxFields) break; out.append('|').append(entry.getKey()).append('=').append(structuredFingerprint(entry.getValue(), level + 1, seen)); }
      return out.toString();
    }
    if (value instanceof Collection<?> collection) {
      StringBuilder out = new StringBuilder("collection"); int i = 0;
      for (Object item : collection) { if (i++ >= snapshotMaxItems) break; out.append('|').append(structuredFingerprint(item, level + 1, seen)); }
      return out.toString();
    }
    if (value.getClass().isArray()) {
      StringBuilder out = new StringBuilder("array"); int n = Math.min(Array.getLength(value), snapshotMaxItems);
      for (int i = 0; i < n; i++) out.append('|').append(structuredFingerprint(Array.get(value, i), level + 1, seen));
      return out.toString();
    }
    return fingerprint(value, level, seen);
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
    SnapshotAdapters.Adapted adapted = SnapshotAdapters.adapt(value);
    if (adapted != null) return "adapter:" + adapted.adapter + ":" + structuredFingerprint(SnapshotAdapters.sanitizedAdapterValue(adapted), level, seen);
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
    System.err.println("[CGTL FLOW] Ordered line replay exclusions: " + System.getProperty("cgtl.flow.excludes", "<none>"));
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
      import java.util.Arrays;
      import java.util.ArrayList;
      import java.util.IdentityHashMap;
      import java.util.List;
import java.util.Set;
import java.util.HashSet;
      import java.util.Map;
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
          String excludes = System.getProperty("cgtl.flow.excludes", "").trim();
          ElementMatcher.Junction<TypeDescription> excluded = ElementMatchers.none();
          for (String token : excludes.split(",")) {
            String rule = token.trim();
            if (rule.isEmpty()) continue;
            if (rule.startsWith("package:")) {
              String pkg = rule.substring("package:".length()).trim();
              if (!pkg.isEmpty()) excluded = excluded.or(ElementMatchers.nameStartsWith(pkg + ".")).or(ElementMatchers.named(pkg));
            } else if (rule.startsWith("class:")) {
              String cls = rule.substring("class:".length()).trim();
              if (!cls.isEmpty()) excluded = excluded.or(ElementMatchers.named(cls)).or(ElementMatchers.nameStartsWith(cls + "$"));
            }
          }
          String adapterClasses = System.getProperty("cgtl.flow.stateAdapters", "").trim();
          for (String token : adapterClasses.split(",")) {
            String adapterClass = token.trim();
            if (adapterClass.isEmpty()) continue;
            excluded = excluded.or(ElementMatchers.named(adapterClass)).or(ElementMatchers.nameStartsWith(adapterClass + "$"));
          }
          // Test classes are intentionally included. Ordered replay must begin in
          // the selected test method so its setup and initial call site are visible.
          return matcher
              .and(ElementMatchers.not(excluded))
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
                  private static final int LOCAL_STATE_SLOT = 1000;
                  private static final int LOCAL_STATE_SIZE = 256;
                  private int injected;
                  private final Map<Label, Integer> labelLines = new IdentityHashMap<>();
                  private final List<LocalMeta> localMetadata = new ArrayList<>();

                  @Override public void visitCode() {
                    super.visitCode();
                    pushInt(this, LOCAL_STATE_SIZE);
                    super.visitTypeInsn(Opcodes.ANEWARRAY, "java/lang/Object");
                    super.visitInsn(Opcodes.DUP);
                    super.visitFieldInsn(Opcodes.GETSTATIC, "local/cgtl/flow/BootstrapAgent", "UNSET_LOCAL", "Ljava/lang/Object;");
                    super.visitMethodInsn(Opcodes.INVOKESTATIC, "java/util/Arrays", "fill", "([Ljava/lang/Object;Ljava/lang/Object;)V", false);
                    super.visitVarInsn(Opcodes.ASTORE, LOCAL_STATE_SLOT);
                  }

                  @Override public void visitVarInsn(int opcode, int variable) {
                    super.visitVarInsn(opcode, variable);
                    if (variable == LOCAL_STATE_SLOT) return;
                    switch (opcode) {
                      case Opcodes.ISTORE -> recordLocal(variable, Opcodes.ILOAD, "java/lang/Integer", "valueOf", "(I)Ljava/lang/Integer;");
                      case Opcodes.LSTORE -> recordLocal(variable, Opcodes.LLOAD, "java/lang/Long", "valueOf", "(J)Ljava/lang/Long;");
                      case Opcodes.FSTORE -> recordLocal(variable, Opcodes.FLOAD, "java/lang/Float", "valueOf", "(F)Ljava/lang/Float;");
                      case Opcodes.DSTORE -> recordLocal(variable, Opcodes.DLOAD, "java/lang/Double", "valueOf", "(D)Ljava/lang/Double;");
                      case Opcodes.ASTORE -> recordReferenceLocal(variable);
                      default -> { }
                    }
                  }

                  @Override public void visitIincInsn(int variable, int increment) {
                    super.visitIincInsn(variable, increment);
                    super.visitVarInsn(Opcodes.ALOAD, LOCAL_STATE_SLOT);
                    pushInt(this, variable);
                    super.visitVarInsn(Opcodes.ILOAD, variable);
                    super.visitMethodInsn(Opcodes.INVOKESTATIC, "java/lang/Integer", "valueOf", "(I)Ljava/lang/Integer;", false);
                    super.visitInsn(Opcodes.AASTORE);
                  }

                  private void recordLocal(int variable, int loadOpcode, String owner, String method, String methodDescriptor) {
                    super.visitVarInsn(Opcodes.ALOAD, LOCAL_STATE_SLOT);
                    pushInt(this, variable);
                    super.visitVarInsn(loadOpcode, variable);
                    super.visitMethodInsn(Opcodes.INVOKESTATIC, owner, method, methodDescriptor, false);
                    super.visitInsn(Opcodes.AASTORE);
                  }

                  private void recordReferenceLocal(int variable) {
                    super.visitVarInsn(Opcodes.ALOAD, LOCAL_STATE_SLOT);
                    pushInt(this, variable);
                    super.visitVarInsn(Opcodes.ALOAD, variable);
                    super.visitInsn(Opcodes.AASTORE);
                  }

                  @Override public void visitLineNumber(int line, Label start) {
                    super.visitLineNumber(line, start);
                    if (line > 0) labelLines.put(start, line);
                    if (line <= 0) return;
                    super.visitLdcInsn(className);
                    super.visitLdcInsn(name);
                    super.visitLdcInsn(descriptor);
                    pushInt(this, line);
                    if (isStatic) super.visitInsn(Opcodes.ACONST_NULL); else super.visitVarInsn(Opcodes.ALOAD, 0);
                    pushInt(this, 0);
                    super.visitTypeInsn(Opcodes.ANEWARRAY, "java/lang/String");
                    super.visitVarInsn(Opcodes.ALOAD, LOCAL_STATE_SLOT);
                    super.visitMethodInsn(Opcodes.INVOKESTATIC, "local/cgtl/flow/BootstrapAgent", "lineState",
                        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ILjava/lang/Object;[Ljava/lang/String;[Ljava/lang/Object;)V", false);
                    injected++;
                  }
                  @Override public void visitLocalVariable(String localName, String localDescriptor, String localSignature,
                      Label start, Label end, int index) {
                    localMetadata.add(new LocalMeta(localName, index, start, end));
                    super.visitLocalVariable(localName, localDescriptor, localSignature, start, end, index);
                  }

                  @Override public void visitEnd() {
                    if (!localMetadata.isEmpty()) {
                      String[] names = new String[localMetadata.size()];
                      int[] slots = new int[localMetadata.size()];
                      int[] starts = new int[localMetadata.size()];
                      int[] ends = new int[localMetadata.size()];
                      for (int i = 0; i < localMetadata.size(); i++) {
                        LocalMeta local = localMetadata.get(i);
                        names[i] = local.name; slots[i] = local.slot;
                        starts[i] = labelLines.getOrDefault(local.start, 0);
                        ends[i] = labelLines.getOrDefault(local.end, Integer.MAX_VALUE);
                      }
                      local.cgtl.flow.BootstrapAgent.registerLocalNames(className, name, descriptor, names, slots, starts, ends);
                    }
                    if (injected > 0) System.err.println("[CGTL FLOW] Line state instrumented " + className + "." + name + "() - " + injected + " lines");
                    super.visitEnd();
                  }

                  private final class LocalMeta {
                    final String name; final int slot; final Label start; final Label end;
                    LocalMeta(String name, int slot, Label start, Label end) {
                      this.name = name; this.slot = slot; this.start = start; this.end = end;
                    }
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
