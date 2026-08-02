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
