# Bazel for Java (community fork, Bazel 9)

Community fork of the Bazel extension for Java™️ Language Support for VS Code
(originally `sfdc.bazel-vscode-java` / `sfdc-eng.bazel-java` by Salesforce OSS,
extension code by [eclipseguru/bazel-vscode-java](https://github.com/eclipseguru/bazel-vscode-java)).
**Not affiliated with or endorsed by Salesforce.**

This extension adds support for Bazel to the Java™️ Language Support for VS Code
(`redhat.java`). It plugs into the Eclipse Java Language server and computes
project dependencies and classpath information using Bazel `BUILD` files.

## Why this fork

The upstream repositories are archived and the published extensions ship a
language-server build from April 2025 that does not work with current Bazel and
`redhat.java` releases. This fork bundles a patched build of the
[bazel-eclipse](https://github.com/salesforce/bazel-eclipse) language-server
extension (BJLS) with the following fixes on top:

- **Bazel 9 / bzlmod support**: IntelliJ aspects (pin `1e99c4`) patched for
  Bazel 9 — `CcInfo`/`cc_common`/`java_common` loaded from `rules_cc`/`rules_java`
  instead of removed builtins, no `struct()` returns from aspect implementations,
  removed dependency on the deleted `--incompatible_py2_outputs_are_suffixed` flag.
- **`org.osgi.service.event` bundle included**: `redhat.java` ≥ 1.55 no longer
  ships it, without it none of the Bazel bundles resolve.
- **Velocity/slf4j compatibility**: `org.apache.velocity.engine-core` manifest
  widened to accept slf4j 2.x shipped by current JDT.LS.
- **Classpath fixes**: `java_proto_library` jars included in the classpath,
  no NPE on targets without an owner label, no ghost "invisible projects" when
  opening subdirectories of a Bazel workspace (multi-root setups).
- **Incremental refresh instead of a full re-sync** (1.4.4): on start the
  projects of an already imported workspace are refreshed from disk, so files
  that appeared while VS Code was closed (branch switch, pull) no longer show
  up as unresolved types. The new command *Java: Refresh Bazel Projects (after
  branch switch / pull)* does the same on demand and additionally re-imports
  only the packages whose `BUILD` file changed (plus the classpaths depending
  on them); it tells you when a full synchronization is really needed (changed
  project view, new or removed packages). Editing a `BUILD` file now triggers
  this incremental update instead of a full workspace synchronization.

## Getting Started

Requires the [Language Support for Java by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.java)
extension (installed automatically as a dependency).

Once installed, open VS Code in any Bazel workspace with Java targets.
The extension looks for a `WORKSPACE` (`WORKSPACE.bazel`) file to identify a
Bazel workspace, then reads the project view from `.eclipse/.bazelproject`
(see [project view docs](https://github.com/salesforce/bazel-eclipse/blob/main/docs/common/projectviews.md))
to determine directories and targets to resolve. If no `.bazelproject` file is
found, a default one importing the whole workspace is generated — for large
repositories create `.eclipse/.bazelproject` with an explicit `directories:`
scope first.

Recommended settings for large repositories:

- Point `java.project.outputPath` outside the repository (otherwise the Eclipse
  builder copies resources into `bin/` inside the repo).
- Add `bin/` to `.bazelignore` as a safety net.
- Disable Gradle/Maven importers if the repository contains unrelated builds:
  `"java.import.gradle.enabled": false`, `"java.import.maven.enabled": false`.

[Troubleshoot tips](https://github.com/eclipseguru/bazel-vscode-java/blob/main/docs/troubleshoot.md)
from the upstream project may be useful if it doesn't "just work".

## Sources

- Extension: https://github.com/tihonove/bazel-vscode-java (branch
  `tihonove/fork`, on top of `eclipseguru/bazel-vscode-java`).
- Language-server bundles (BJLS): https://github.com/tihonove/bazel-eclipse
  (branch `tihonove/bazel9`, on top of the archived `salesforce/bazel-eclipse`
  main). Every change is marked `LOCAL PATCH` in the sources.

## Building

The packaged language-server bundles are taken from a pre-built jar set
(`npm run build:server` copies them from a local directory; see
`scripts/server.mjs`, command `copy-server <jars-dir>`). They are built from
the `bazel-eclipse` fork above with
`./mvnw -DskipTests verify` (JDK 21) and taken from
`releng/p2repository/target/repository/plugins/`:

```sh
npm ci
npm run package   # produces bazel-java-<version>.vsix
```

## License

BSD 3-Clause (extension, © Salesforce). Bundled language-server jars are
EPL-2.0 ([bazel-eclipse](https://github.com/salesforce/bazel-eclipse)); bundled
IntelliJ aspects are Apache-2.0 ([bazelbuild/intellij](https://github.com/bazelbuild/intellij)).
