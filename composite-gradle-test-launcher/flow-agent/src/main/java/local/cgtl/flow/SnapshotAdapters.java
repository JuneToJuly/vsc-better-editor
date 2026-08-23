package local.cgtl.flow;

import java.io.File;
import java.lang.reflect.Array;
import java.lang.reflect.Method;
import java.net.URI;
import java.net.URL;
import java.net.InetSocketAddress;
import java.nio.file.Path;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Currency;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalDouble;
import java.util.OptionalInt;
import java.util.OptionalLong;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Safe semantic snapshots for common JDK values plus opt-in project adapters.
 *
 * Custom adapter contract (no CGTL compile dependency required):
 *   public static boolean supports(Class<?> type)
 *   public static Object snapshot(Object value)
 *
 * snapshot(...) should return a scalar, Map, Collection, array, or null. A Map may
 * contain the reserved key "$display" to control the compact value shown in Replay.
 */
final class SnapshotAdapters {
  static final class Adapted {
    final String adapter;
    final String display;
    final Object value;
    Adapted(String adapter, String display, Object value) {
      this.adapter = adapter;
      this.display = display;
      this.value = value;
    }
  }

  private static final Object NONE = new Object();
  private static final ConcurrentHashMap<String, Object> CUSTOM = new ConcurrentHashMap<>();
  private static final ConcurrentHashMap<String, Boolean> REPORTED_FAILURES = new ConcurrentHashMap<>();

  private SnapshotAdapters() {}

  static Adapted adapt(Object value) {
    if (value == null) return null;
    Adapted custom = custom(value);
    if (custom != null) return custom;
    try {
      if (value instanceof Path path) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>();
        fields.put("path", path.toString());
        fields.put("absolute", path.isAbsolute());
        fields.put("root", text(path.getRoot()));
        fields.put("parent", text(path.getParent()));
        fields.put("fileName", text(path.getFileName()));
        fields.put("nameCount", path.getNameCount());
        return new Adapted("Path", path.toString(), fields);
      }
      if (value instanceof File file) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>();
        fields.put("path", file.getPath());
        fields.put("absolute", file.isAbsolute());
        fields.put("absolutePath", file.getAbsolutePath());
        fields.put("name", file.getName());
        fields.put("parent", file.getParent());
        return new Adapted("File", file.getPath(), fields);
      }
      if (value instanceof URI uri) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>();
        fields.put("scheme", uri.getScheme()); fields.put("authority", uri.getAuthority());
        fields.put("host", uri.getHost()); fields.put("port", uri.getPort());
        fields.put("path", uri.getPath()); fields.put("query", uri.getQuery()); fields.put("fragment", uri.getFragment());
        return new Adapted("URI", uri.toString(), fields);
      }
      if (value instanceof URL url) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>();
        fields.put("protocol", url.getProtocol()); fields.put("host", url.getHost()); fields.put("port", url.getPort());
        fields.put("path", url.getPath()); fields.put("query", url.getQuery()); fields.put("ref", url.getRef());
        return new Adapted("URL", url.toExternalForm(), fields);
      }
      if (value instanceof Optional<?> optional) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>();
        fields.put("present", optional.isPresent());
        if (optional.isPresent()) fields.put("value", optional.get());
        return new Adapted("Optional", optional.isPresent() ? "present" : "empty", fields);
      }
      if (value instanceof OptionalInt optional) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>(); fields.put("present", optional.isPresent());
        if (optional.isPresent()) fields.put("value", optional.getAsInt());
        return new Adapted("OptionalInt", optional.isPresent() ? String.valueOf(optional.getAsInt()) : "empty", fields);
      }
      if (value instanceof OptionalLong optional) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>(); fields.put("present", optional.isPresent());
        if (optional.isPresent()) fields.put("value", optional.getAsLong());
        return new Adapted("OptionalLong", optional.isPresent() ? String.valueOf(optional.getAsLong()) : "empty", fields);
      }
      if (value instanceof OptionalDouble optional) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>(); fields.put("present", optional.isPresent());
        if (optional.isPresent()) fields.put("value", optional.getAsDouble());
        return new Adapted("OptionalDouble", optional.isPresent() ? String.valueOf(optional.getAsDouble()) : "empty", fields);
      }
      if (value instanceof UUID uuid) return new Adapted("UUID", uuid.toString(), Map.of("value", uuid.toString()));
      if (value instanceof Pattern pattern) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>(); fields.put("pattern", pattern.pattern()); fields.put("flags", pattern.flags());
        return new Adapted("Pattern", pattern.pattern(), fields);
      }
      if (value instanceof Locale locale) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>(); fields.put("languageTag", locale.toLanguageTag()); fields.put("language", locale.getLanguage()); fields.put("country", locale.getCountry()); fields.put("variant", locale.getVariant());
        return new Adapted("Locale", locale.toLanguageTag(), fields);
      }
      if (value instanceof Currency currency) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>(); fields.put("currencyCode", currency.getCurrencyCode()); fields.put("numericCode", currency.getNumericCode()); fields.put("defaultFractionDigits", currency.getDefaultFractionDigits());
        return new Adapted("Currency", currency.getCurrencyCode(), fields);
      }
      if (value instanceof InetSocketAddress address) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>(); fields.put("host", address.getHostString()); fields.put("port", address.getPort()); fields.put("unresolved", address.isUnresolved());
        return new Adapted("InetSocketAddress", address.getHostString() + ":" + address.getPort(), fields);
      }
      if (value instanceof Class<?> cls) {
        LinkedHashMap<String,Object> fields = new LinkedHashMap<>(); fields.put("name", cls.getName()); fields.put("simpleName", cls.getSimpleName()); fields.put("package", cls.getPackageName()); fields.put("interface", cls.isInterface()); fields.put("enum", cls.isEnum()); fields.put("record", cls.isRecord()); fields.put("array", cls.isArray());
        return new Adapted("Class", cls.getName(), fields);
      }
      String name = value.getClass().getName();
      if (name.startsWith("java.time.")) {
        return new Adapted("JavaTime", String.valueOf(value), Map.of("value", String.valueOf(value), "kind", value.getClass().getSimpleName()));
      }
      if (value instanceof ZoneId zone) return new Adapted("ZoneId", zone.getId(), Map.of("id", zone.getId()));
    } catch (Throwable error) {
      report("built-in:" + value.getClass().getName(), error);
    }
    return null;
  }

  private static Adapted custom(Object value) {
    String raw = System.getProperty("cgtl.flow.stateAdapters", "").trim();
    if (raw.isEmpty()) return null;
    for (String token : raw.split(",")) {
      String className = token.trim();
      if (className.isEmpty()) continue;
      try {
        Object adapter = customAdapter(className, value.getClass());
        if (adapter == NONE) continue;
        Class<?> cls = (Class<?>) adapter;
        Method supports = cls.getMethod("supports", Class.class);
        if (!Boolean.TRUE.equals(supports.invoke(null, value.getClass()))) continue;
        Method snapshot = cls.getMethod("snapshot", Object.class);
        Object result = snapshot.invoke(null, value);
        String display = null;
        if (result instanceof Map<?,?> map && map.containsKey("$display")) display = String.valueOf(map.get("$display"));
        if (display == null && isSimple(result)) display = result == null ? "null" : String.valueOf(result);
        return new Adapted(cls.getName(), display, result);
      } catch (Throwable error) {
        report("custom:" + className, unwrap(error));
      }
    }
    return null;
  }

  private static Object customAdapter(String className, Class<?> valueType) {
    String loaderKey = className + "@" + System.identityHashCode(Thread.currentThread().getContextClassLoader()) + ":" + System.identityHashCode(valueType.getClassLoader());
    return CUSTOM.computeIfAbsent(loaderKey, key -> {
      List<ClassLoader> loaders = new ArrayList<>();
      loaders.add(Thread.currentThread().getContextClassLoader());
      loaders.add(valueType.getClassLoader());
      loaders.add(ClassLoader.getSystemClassLoader());
      for (ClassLoader loader : loaders) {
        if (loader == null) continue;
        try { return Class.forName(className, true, loader); } catch (Throwable ignored) {}
      }
      return NONE;
    });
  }

  static boolean isSimple(Object value) {
    return value == null || value instanceof String || value instanceof Character || value instanceof Enum<?> || value instanceof Number || value instanceof Boolean;
  }

  static Object sanitizedAdapterValue(Adapted adapted) {
    if (adapted == null) return null;
    Object value = adapted.value;
    if (value instanceof Map<?,?> map && map.containsKey("$display")) {
      LinkedHashMap<Object,Object> copy = new LinkedHashMap<>();
      for (Map.Entry<?,?> entry : map.entrySet()) if (!"$display".equals(String.valueOf(entry.getKey()))) copy.put(entry.getKey(), entry.getValue());
      return copy;
    }
    return value;
  }

  private static String text(Object value) { return value == null ? null : String.valueOf(value); }
  private static Throwable unwrap(Throwable error) {
    if (error instanceof java.lang.reflect.InvocationTargetException invocation && invocation.getCause() != null) return invocation.getCause();
    return error;
  }
  private static void report(String key, Throwable error) {
    if (REPORTED_FAILURES.putIfAbsent(key, Boolean.TRUE) == null) {
      System.err.println("[CGTL FLOW] Replay state adapter failed " + key + ": " + error);
    }
  }
}
