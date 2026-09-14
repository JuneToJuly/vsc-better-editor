# CGTL Replay — How to Run Locally and Remotely

This guide covers the complete workflow for producing a **valid CGTL Replay** from a Java application using the Replay Manager.

It covers:

- preparing the application binary;
- building the exact Replay source bundle;
- configuring the Replay Manager;
- inheriting workspace state adapters;
- starting the Replay receiver;
- running an application locally;
- running an application remotely with the generated script;
- running an application locally or remotely in Docker/Podman;
- understanding source transfer and validation;
- confirming that the resulting Replay is valid.

This guide stops once the Replay has been successfully imported. The Replay viewer itself should be documented separately.

---

# 1. What a valid Replay requires

A valid source-level Replay needs three independent pieces:

```text
1. Executed Java binary
2. Replay capture
3. Exact source corresponding to the executed code
```

For full state capture, the executed classes should also contain normal Java debug metadata such as:

```text
LineNumberTable
LocalVariableTable
```

Normal Gradle Java builds typically include this information by default.

If custom Replay state adapters are configured in the workspace, CGTL also needs the compiled adapter classes when the application is launched outside the normal test-runner workflow.

---

# 2. Recommended build artifacts

For a fat JAR application, the recommended pair is:

```text
my-application-1.0.0-all.jar
my-application-1.0.0-replay-sources.jar
```

The binary JAR contains the classes that will execute.

The Replay sources JAR contains the source corresponding to those classes.

For example:

```text
my-application-1.0.0-all.jar
├─ com/acme/orders/OrderProcessor.class
├─ com/acme/orders/PricingService.class
└─ org/apache/commons/lang3/StringUtils.class
```

and:

```text
my-application-1.0.0-replay-sources.jar
├─ com/acme/orders/OrderProcessor.java
├─ com/acme/orders/PricingService.java
└─ org/apache/commons/lang3/StringUtils.java
```

The Replay sources JAR is particularly important for:

- Shadow JARs;
- Spring Boot executable JARs;
- remote builds;
- snapshot builds;
- builds created by another developer;
- dependency code that is instrumented by Replay.

---

# 3. Build a fat Replay sources JAR

A normal Gradle `sourcesJar` typically contains only the current project's source.

For Replay, a fat executable may also contain runtime dependency classes. If those classes execute and are instrumented, Replay needs their source as well.

The tested Gradle approach is:

```groovy
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.artifacts.result.ResolvedArtifactResult
import org.gradle.jvm.JvmLibrary
import org.gradle.language.base.artifact.SourcesArtifact

def replayDependencySources = providers.provider {
    def componentIds = configurations.runtimeClasspath
        .incoming
        .resolutionResult
        .allComponents
        .collect { it.id }
        .findAll { it instanceof ModuleComponentIdentifier }

    def result = dependencies
        .createArtifactResolutionQuery()
        .forComponents(componentIds)
        .withArtifacts(JvmLibrary, SourcesArtifact)
        .execute()

    result.resolvedComponents.collectMany { component ->
        component
            .getArtifacts(SourcesArtifact)
            .findAll { it instanceof ResolvedArtifactResult }
            .collect { it.file }
    }
}

tasks.register('replaySourcesJar', Jar) {
    group = 'build'
    description = 'Builds a fat sources JAR for CGTL Replay'

    archiveClassifier = 'replay-sources'
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE

    from(sourceSets.main.allSource) {
        include '**/*.java'
        include '**/*.kt'
    }

    from({
        replayDependencySources.get().collect { sourceJar ->
            zipTree(sourceJar)
        }
    }) {
        include '**/*.java'
        include '**/*.kt'
    }
}
```

This task includes:

```text
your application source
+
source artifacts from runtime dependencies
```

when those dependencies publish source JARs.

## Example with Shadow

With the Shadow plugin:

```groovy
plugins {
    id 'java'
    id 'application'
    id 'com.gradleup.shadow' version '9.2.2'
}
```

build both artifacts with:

```powershell
gradle clean shadowJar replaySourcesJar
```

or:

```bash
./gradlew clean shadowJar replaySourcesJar
```

The resulting files should look similar to:

```text
build/libs/my-application-1.0.0-all.jar
build/libs/my-application-1.0.0-replay-sources.jar
```

## Verify the source bundle

For an external dependency such as Apache Commons Lang:

```powershell
jar tf build\libs\my-application-1.0.0-replay-sources.jar |
    Select-String "StringUtils.java"
```

or on Linux:

```bash
jar tf build/libs/my-application-1.0.0-replay-sources.jar \
    | grep StringUtils.java
```

If the dependency is part of the runtime classpath and publishes sources, you should see something like:

```text
org/apache/commons/lang3/StringUtils.java
```

---

# 4. Workspace Replay adapters

Replay Manager automatically inherits adapters configured through the normal workspace Replay configuration.

For example:

```json
"compositeGradleTests.flowStateAdapterClasses": [
    "cgtl.replay.adapters.AtomicBooleanReplayAdapter"
]
```

You do **not** configure adapters separately on each Replay Manager launch.

Before generating or running an external Replay launch, the adapter classes must be compiled.

For example:

```powershell
gradle testClasses
```

or:

```bash
./gradlew testClasses
```

CGTL packages the compiled adapter classes into the Replay runtime:

```text
replay-runtime/
└─ adapters/
   └─ classes/
      └─ cgtl/
         └─ replay/
            └─ adapters/
               └─ AtomicBooleanReplayAdapter.class
```

Generated launches then include both:

```text
-Dcgtl.flow.stateAdapters=cgtl.replay.adapters.AtomicBooleanReplayAdapter
```

and:

```text
-Dcgtl.flow.adapterClasspath=<replay-runtime>/adapters/classes
```

If an adapter is configured but cannot be packaged, CGTL should stop the launch rather than silently running without it.

---

# 5. Configure Replay Manager

Open the Replay Manager in VS Code.

Its high-level structure is:

```text
Replay Manager
├─ Receiver
├─ Launches
│  ├─ JAR Launches
│  └─ Container Launches
└─ Imports
   ├─ Import Capture…
   └─ Watched Folders
```

For a JAR launch, configure:

- launch name;
- executable JAR;
- Replay sources JAR;
- included packages/classes;
- exclusions;
- application arguments.

For example:

```text
Executable:
build/libs/my-application-1.0.0-all.jar

Sources:
build/libs/my-application-1.0.0-replay-sources.jar

Packages:
com.acme.orders
com.acme.shared

Arguments:
--scenario review
```

The package list determines what Replay instruments.

Be deliberate here. Instrument your application packages and any dependency packages you specifically want Replay to enter.

---

# 6. Start the Replay receiver

Before running a remote Replay, start the receiver from Replay Manager.

The default port is:

```text
57321
```

The receiver owns:

- bind host;
- TCP port;
- authentication token.

For another machine to reach your receiver, the receiver must bind to an address reachable by that machine and the network/firewall must allow the connection.

The sender connects **to** the Replay receiver.

Conceptually:

```text
Remote application
      |
      | outbound TCP
      v
VS Code Replay Receiver
```

The receiver does not connect into the remote application.

---

# 7. Running remotely with the standard generated script

This is the simplest way to run a Java application on another computer without installing the VS Code extension there.

## Step 1 — Configure the launch

On the development workstation:

1. Open Replay Manager.
2. Add or edit a JAR Launch.
3. Select the executable fat JAR.
4. Select the matching Replay sources JAR.
5. Configure packages and exclusions.
6. Configure application arguments.
7. Ensure any workspace Replay adapters are compiled.

## Step 2 — Start the receiver

Start the Replay receiver in VS Code.

For a remote machine, make sure the receiver address is reachable from that machine.

Do not use:

```text
127.0.0.1
```

as the remote receiver address unless the Java process is running on the same machine.

Use the workstation address reachable from the remote host.

## Step 3 — Generate the remote script

Use the Replay Manager action to generate the JAR launch script.

Choose the option indicating that the application will run on **another computer**.

CGTL generates a launch package containing items such as:

```text
run-replay.ps1             Windows
run-replay.sh              Linux

replay-runtime/
├─ cgtl-flow-agent.jar
├─ byte-buddy-*.jar
├─ application-sources.jar
└─ adapters/
   └─ classes/
```

Depending on how the launch was generated, the executable application JAR may also be copied or the script may expect it at a configured path.

A Windows script will conceptually contain:

```powershell
$Agent = Join-Path $Root 'replay-runtime/cgtl-flow-agent.jar'
$ByteBuddy = Join-Path $Root 'replay-runtime/byte-buddy-1.18.7.jar'
$Sources = Join-Path $Root 'replay-runtime/application-sources.jar'
$Adapters = Join-Path $Root 'replay-runtime/adapters/classes'

$env:CGTL_REPLAY_HOST='<receiver-host>'
$env:CGTL_REPLAY_PORT='57321'
$env:CGTL_REPLAY_TOKEN='<receiver-token>'

java `
  "-javaagent:$Agent" `
  "-Xbootclasspath/a:$ByteBuddy" `
  "-Dcgtl.flow.byteBuddyJar=$ByteBuddy" `
  "-Dcgtl.flow.applicationJar=$Jar" `
  "-Dcgtl.flow.sourcesJar=$Sources" `
  "-Dcgtl.flow.adapterClasspath=$Adapters" `
  '-Dcgtl.flow.stateAdapters=...' `
  '-Dcgtl.flow.packages=...' `
  -jar $Jar
```

## Step 4 — Copy the generated launch package to the remote computer

Copy the entire generated launch folder.

Do not copy only the script.

The runtime files beside it are required.

At minimum, keep this structure intact:

```text
generated-replay-launch/
├─ run-replay.ps1 or run-replay.sh
├─ application JAR, if bundled
└─ replay-runtime/
   ├─ cgtl-flow-agent.jar
   ├─ byte-buddy-*.jar
   ├─ application-sources.jar
   └─ adapters/
```

## Step 5 — Run the script remotely

On Windows:

```powershell
.\run-replay.ps1
```

On Linux:

```bash
chmod +x run-replay.sh
./run-replay.sh
```

The application starts normally with the Replay agent attached.

## Step 6 — Application executes

Replay records the configured code.

When the Java process exits, the Replay agent finalizes the capture.

## Step 7 — Capture is sent to the receiver

The agent connects to the receiver using:

```text
CGTL_REPLAY_HOST
CGTL_REPLAY_PORT
CGTL_REPLAY_TOKEN
```

and sends:

- the Replay capture;
- application/source identity;
- hashes for source files corresponding to executed classes.

## Step 8 — Receiver resolves exact source

The receiver attempts exact-source resolution in this order:

```text
1. Exact Replay source cache
2. Verified current workspace source
3. Exact matching source JAR from local Gradle cache
4. Request source JAR from sender
```

If the current workspace exactly matches all required executed source files, no source bundle needs to be transferred.

If the workspace differs, the receiver can request the source JAR from the remote agent.

The source JAR is transferred only when necessary.

## Step 9 — Replay is imported

Once all required source can be resolved, Replay is imported and opened.

If required source cannot be obtained, CGTL preserves the capture but does **not** open a misleading partial source-level Replay.

The user should see a clear error identifying the missing source.

---

# 8. Running remotely in Docker or Podman

Replay Manager can also generate a container launch.

The design is:

```text
Container
   |
   | outbound TCP
   v
Replay Receiver
```

The Replay agent and related runtime are mounted into the container.

The application image itself does not need to permanently contain CGTL.

## Step 1 — Build the executable and Replay source bundle

For example:

```powershell
gradle clean shadowJar replaySourcesJar
```

or:

```bash
./gradlew clean shadowJar replaySourcesJar
```

## Step 2 — Configure a Container Launch

In Replay Manager configure:

- name;
- engine: Docker or Podman;
- image;
- included packages/classes;
- exclusions;
- application arguments;
- Replay sources JAR.

Replay Manager also inherits workspace adapters automatically.

## Step 3 — Start the receiver

Start the Replay receiver on the development workstation.

For a container running on another machine, the receiver host must be reachable from that remote machine.

## Step 4 — Generate the container run script/command

Generate the container run configuration from Replay Manager.

The generated runtime is mounted into the container, typically at:

```text
/cgtl-replay
```

The container receives Java options equivalent to:

```text
JAVA_TOOL_OPTIONS=
  -javaagent:/cgtl-replay/cgtl-flow-agent.jar
  -Dcgtl.flow.sourcesJar=/cgtl-replay/application-sources.jar
  -Dcgtl.flow.adapterClasspath=/cgtl-replay/adapters/classes
  ...
```

This allows the existing container entrypoint to continue starting Java normally.

## Local Docker host address

For Docker running on the same machine as VS Code, Replay can use:

```text
host.docker.internal
```

and where needed:

```text
--add-host=host.docker.internal:host-gateway
```

## Local Podman host address

For Podman:

```text
host.containers.internal
```

is the typical host alias.

## Remote container host address

If Docker/Podman is running on another computer, do not use the local-container alias to refer to your VS Code workstation.

Use the actual receiver address reachable from the remote host.

## No Replay port publication is normally required

You generally do not need:

```text
-p 57321:57321
```

because the container initiates the outbound connection to the receiver.

## Step 5 — Run the generated container launch

Run the generated command/script on the target host.

The Java application starts with `JAVA_TOOL_OPTIONS` injecting Replay.

## Step 6 — Capture, source negotiation, and import

The remaining workflow is the same as the standard remote script:

```text
Application exits
      ↓
Agent finalizes Replay capture
      ↓
Agent uploads capture
      ↓
Receiver verifies exact source
      ↓
Source JAR requested only if necessary
      ↓
Replay imported
```

---

# 9. Running locally from Replay Manager

The local workflow is simpler because VS Code, the workspace, and the Java application are all on the same computer.

## Step 1 — Build the application

For a fat JAR:

```powershell
gradle clean shadowJar replaySourcesJar
```

or:

```bash
./gradlew clean shadowJar replaySourcesJar
```

You should have:

```text
build/libs/my-application-1.0.0-all.jar
build/libs/my-application-1.0.0-replay-sources.jar
```

## Step 2 — Compile adapters

If workspace Replay adapters are configured:

```powershell
gradle testClasses
```

or whichever Gradle task produces those adapter classes.

The Replay Manager will package those compiled classes automatically.

## Step 3 — Configure the JAR Launch

In Replay Manager:

1. Add a JAR Launch.
2. Select the fat executable JAR.
3. Select the Replay source JAR.
4. Enter included packages.
5. Enter exclusions if needed.
6. Enter application arguments.

Example:

```text
Name:
Orders Replay

Executable:
build/libs/orders-1.0.0-all.jar

Sources:
build/libs/orders-1.0.0-replay-sources.jar

Packages:
com.acme.orders
com.acme.shared
```

## Step 4 — Start the receiver

Start the Replay receiver.

For a fully local run, loopback is fine:

```text
127.0.0.1
```

## Step 5 — Run from Replay Manager

Use the JAR Launch's **Run** action.

CGTL launches Java with:

```text
-javaagent
Byte Buddy
application JAR identity
source JAR identity
package filters
capture configuration
workspace adapters
adapter classpath
receiver configuration
```

You do not need to manually construct the Java command.

## Step 6 — Let the application finish

When the process exits, the Java agent finalizes the Replay capture and sends it to the receiver.

## Step 7 — Source verification

For a normal local development build, the likely fast path is:

```text
Capture arrives
      ↓
Receiver finds workspace files
      ↓
Executed source hashes match
      ↓
Workspace is accepted as exact source
      ↓
No source JAR transfer required
```

Even though the Replay source JAR exists, it does not need to be transferred when the receiver can prove that the current workspace is already exact.

## Step 8 — Replay opens

Once source resolution succeeds, the Replay is imported and opened.

---

# 10. Running locally using a generated script

You can also generate a script and run it on the same computer.

This is useful when:

- application startup must happen outside VS Code;
- you want a reproducible command;
- you want to test the same workflow that will later be used remotely.

Generate the script for **this computer**.

Then run:

```powershell
.\run-replay.ps1
```

or:

```bash
./run-replay.sh
```

The receiver can remain on:

```text
127.0.0.1:57321
```

because the script and VS Code are running on the same host.

All source and adapter behavior remains the same.

---

# 11. Running locally in Docker/Podman

For a local container:

1. Build the executable and Replay sources JAR.
2. Configure a Container Launch.
3. Start the Replay receiver.
4. Generate or run the container launch.
5. Replay mounts its runtime into the container.
6. The application starts with Replay injected through `JAVA_TOOL_OPTIONS`.
7. The container connects outward to the host receiver.
8. Source is verified.
9. Replay imports.

Typical host aliases are:

```text
Docker:
host.docker.internal

Podman:
host.containers.internal
```

Again, Replay does not normally need a published inbound container port.

---

# 12. What happens when source does not match

Suppose the application was built from:

```text
feature/order-rework
```

but the receiving workstation currently has:

```text
main
```

Replay does not trust the matching path alone.

The agent sends normalized SHA-256 hashes for source files corresponding to executed classes.

The receiver compares those against the current workspace.

If:

```text
com/acme/orders/OrderProcessor.java
```

differs, the workspace is rejected as exact source for that Replay.

Replay then looks for:

```text
the exact cached Replay source bundle
or
the exact source JAR in Gradle cache
or
the source JAR available from the sender
```

This is why snapshot builds remain safe even when both binaries have names such as:

```text
orders-1.0.0-SNAPSHOT.jar
```

The source identity is based on content rather than version text.

---

# 13. What happens if required source is unavailable

CGTL intentionally does not fall back to decompiled source as if it were exact source.

If required source cannot be resolved, the capture is preserved but the source-level Replay is blocked.

The expected behavior is similar to:

```text
Replay not opened: required source code is unavailable
for 3 executed classes.

The capture was preserved.

Provide the matching source JAR or matching workspace
source, then import the capture again.
```

The output should also identify the missing classes.

For example:

```text
[CGTL SOURCES] REPLAY BLOCKED:
3 executed class(es) have no resolvable source.

missing com.acme.orders.OrderProcessor
missing com.acme.orders.PricingService
missing com.acme.orders.InventoryService
```

This is deliberate.

CGTL should prefer a clearly incomplete Replay over displaying source that may not correspond to the recorded execution.

---

# 14. Valid Replay checklist

Before expecting a complete Replay, verify:

## Build

```text
[ ] Executable/fat JAR exists
[ ] Replay fat sources JAR exists
[ ] Source JAR contains application source
[ ] Source JAR contains sources for instrumented dependencies
    where those sources are published
```

## Debug metadata

```text
[ ] Classes were compiled with normal Java debug metadata
[ ] LocalVariableTable is present when local-variable capture is expected
```

## Replay configuration

```text
[ ] Executable JAR configured
[ ] Matching Replay source JAR configured
[ ] Correct application packages included
[ ] Required dependency packages included if you want to replay them
[ ] Unwanted packages excluded
```

## Adapters

```text
[ ] Workspace adapter list is correct
[ ] Adapter classes have been compiled
[ ] Generated runtime contains adapters/classes
[ ] Launch contains cgtl.flow.stateAdapters
[ ] Launch contains cgtl.flow.adapterClasspath
```

## Receiver

```text
[ ] Replay receiver is running
[ ] Sender can reach receiver host
[ ] Port is reachable
[ ] Generated script contains the current receiver token
```

## Remote launch

```text
[ ] Entire generated launch folder was copied
[ ] replay-runtime directory remained intact
[ ] Java exists on remote machine
[ ] Application JAR path is valid
[ ] Sources JAR is present in replay-runtime if generated that way
```

## Container launch

```text
[ ] Replay runtime is mounted into container
[ ] JAVA_TOOL_OPTIONS is present
[ ] Container can reach receiver
[ ] Correct Docker/Podman host address is used
```

## Result

```text
[ ] Capture reaches receiver
[ ] Exact source resolution succeeds
[ ] No missing-source warning appears
[ ] Replay is imported/opened
```

---

# 15. Troubleshooting

## Capture never reaches VS Code

Check:

```text
receiver running?
correct host?
correct port?
correct token?
firewall?
remote machine can route to workstation?
```

For remote launches, `127.0.0.1` points to the remote computer itself, not your development workstation.

---

## Replay says source is unavailable

Verify that the Replay sources JAR actually contains the missing path:

```powershell
jar tf application-replay-sources.jar |
    Select-String "OrderProcessor.java"
```

or:

```bash
jar tf application-replay-sources.jar |
    grep OrderProcessor.java
```

Also confirm that the source JAR was produced from the same build/source state as the executable.

---

## Dependency classes appear in the fat JAR but not in Replay sources

A normal `sourcesJar` is not enough for a fat JAR.

Use the `replaySourcesJar` task that explicitly resolves dependency source artifacts from `runtimeClasspath`.

---

## Adapter is configured but never executes

Inspect the generated script.

It should contain both:

```text
-Dcgtl.flow.stateAdapters=<adapter-class>
```

and:

```text
-Dcgtl.flow.adapterClasspath=<adapter-directory>
```

Also verify that the corresponding `.class` exists under:

```text
replay-runtime/adapters/classes/
```

If not, rebuild the project/test classes and regenerate the launch.

---

## Replay has methods/lines but no local variables

Inspect the compiled class:

```powershell
javap -l -p path\to\MyClass.class
```

Look for:

```text
LocalVariableTable
```

If it is absent, the binary was compiled without the local-variable debug metadata Replay needs to associate local JVM slots with source variable names.

This is separate from the source-JAR mechanism.

---

# 16. Recommended everyday workflows

## Local developer

```text
gradle shadowJar replaySourcesJar
        ↓
Replay Manager → Run
        ↓
receiver gets capture
        ↓
workspace hashes match
        ↓
Replay opens
```

## Remote developer / remote machine

```text
gradle shadowJar replaySourcesJar
        ↓
Replay Manager → Generate Script
        ↓
copy generated folder to target
        ↓
start receiver in VS Code
        ↓
run generated script remotely
        ↓
capture uploads
        ↓
source transferred only if needed
        ↓
Replay opens
```

## Local container

```text
build executable + Replay sources
        ↓
Replay Manager → Container Launch
        ↓
start receiver
        ↓
run Docker/Podman launch
        ↓
container connects to host
        ↓
Replay opens
```

## Remote container

```text
build executable + Replay sources
        ↓
generate remote container launch
        ↓
copy runtime/configuration to remote host
        ↓
start receiver on development workstation
        ↓
run container remotely
        ↓
container connects to workstation receiver
        ↓
source negotiated
        ↓
Replay opens
```

---

# 17. The key rule

The most important rule is:

> Build the executable and Replay source bundle together, then let CGTL verify that the source used for Replay actually matches the code that executed.

The generated scripts, receiver protocol, source hashes, source cache, Gradle-cache lookup, remote source negotiation, and workspace adapter packaging all exist to make that rule work across local, remote, and containerized applications.
