# CGTL Flow Agent Source

This is the source used to build `resources/cgtl-flow-agent.jar`. The agent JAR is intentionally thin: Byte Buddy is resolved separately by the extension's generated Gradle init script.

Build with the same Byte Buddy version configured in VS Code:

```bash
gradle clean jar -PbyteBuddyVersion=1.18.7
```

For an offline Maven repository:

```bash
gradle clean jar \
  -PbyteBuddyVersion=1.18.7 \
  -PdependencyRepository=file:///opt/offline-maven
```

Copy `build/libs/cgtl-flow-agent.jar` to the extension's `resources/` directory when rebuilding the agent. The configured Byte Buddy version must match the API used to compile this source.

## Ordered line replay

The packaged agent starts through `BootstrapAgent`. It installs the existing method snapshot agent, then compiles a small line-number transformer against the exact Byte Buddy jar selected by the extension (`cgtl.flow.byteBuddyJar`). This preserves offline/version configurability while avoiding a Byte Buddy binary mismatch.

Line events intentionally contain metadata only in phase one. Receiver/argument/outcome snapshots remain at method and call boundaries.


## Replay state adapters

CGTL uses semantic adapters before falling back to bounded reflection. Built-in adapters cover common JDK values including `Path`, `File`, `URI`, `URL`, `Optional`, `UUID`, `java.time` values, regex `Pattern`, `Locale`, `Currency`, `Class`, and `InetSocketAddress`.

Project adapters are ordinary test-runtime classes; they do not need to compile against CGTL. The recommended location is:

```text
src/test/java/cgtl/replay/adapters/
```

An adapter exposes exactly two public static methods:

```java
public static boolean supports(Class<?> type)
public static Object snapshot(Object value)
```

`snapshot` should return a scalar, `Map`, `Collection`, array, or `null`. A map can use the reserved `$display` entry for the compact label shown by Replay:

```java
package cgtl.replay.adapters;

import java.util.LinkedHashMap;
import java.util.Map;

public final class MoneyReplayAdapter {
    public static boolean supports(Class<?> type) {
        return "com.example.money.Money".equals(type.getName());
    }

    public static Object snapshot(Object value) {
        com.example.money.Money money = (com.example.money.Money) value;
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("$display", money.amount() + " " + money.currency());
        state.put("amount", money.amount());
        state.put("currency", money.currency());
        return state;
    }
}
```

Register the fully qualified adapter class in `compositeGradleTests.flowStateAdapterClasses`, or use **Replay State: Create Custom Adapter** from VS Code. Adapter code runs inside the test JVM during capture and must be side-effect free. Adapter failures are logged and never fail the test or Replay capture.
