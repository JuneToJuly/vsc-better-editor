# Fast Composite JDT

A deliberately small Gradle composite-build adapter for VS Code's Red Hat Java/JDT language server.

## What it does

- Uses Gradle only to extract the Java project model.
- Supports Gradle composite builds and included-build project substitution.
- Maps participating local Gradle projects to JDT project references.
- Keeps non-local resolved dependencies as JAR classpath entries.
- Generates Eclipse `.project`, `.classpath`, and JDT compiler preferences.
- Disables JDT's normal Gradle importer by default.
- Caches models so ordinary VS Code startup does not invoke Gradle.
- Supports multiple named/registered composite roots and cache-first switching between them.

## Commands

- **Fast Composite JDT: Resync Java Model** — run Gradle for the active composite root and replace its cached model.
- **Fast Composite JDT: Add Composite Root** — register another folder containing `settings.gradle` or `settings.gradle.kts`.
- **Fast Composite JDT: Switch Composite Root** — make a registered root the active JDT dependency configuration. If cached, switching does not invoke Gradle.
- **Fast Composite JDT: Remove Composite Root** — unregister a root and delete its cached model.
- **Fast Composite JDT: Show Model Status**
- **Fast Composite JDT: Clear Cached Model** — clears only the active root's cache.

The status-bar item shows the active root and opens **Switch Composite Root** when clicked.

## Model switching

The active Gradle composite is the source of truth for locality. Merely having a repository in the VS Code workspace does not force it to be used as source. If the active composite resolves a dependency as a Gradle project component, JDT gets a local project reference. If Gradle resolves it as a module artifact, JDT gets the JAR.

This makes it possible to keep multiple development/review configurations without changing every Git branch. A cached configuration switch only rewrites the JDT metadata and requests a Java-project refresh.

## Normal source changes

No sync is required when adding/editing/removing Java files under already-known source roots; JDT watches those. Resync when the project model changes: dependencies, versions, source sets, included builds, toolchain/compiler configuration, or a newly registered composite root.


## JDT project naming

JDT project names are derived from Gradle build-tree project paths. For example, `:shared-model` is shown as `shared-model`, while `:services:api` is shown as `services-api`. A numeric suffix is used only when two Gradle paths would otherwise collapse to the same Eclipse-safe project name.
