# Packaging

## Purpose

This surface is the npm package as the Signal K server and the operator receive it. It covers the manifest fields the server reads to discover, list, load, and depict the plugin; the module shape the server obtains when it loads the package; the files the published tarball carries and the files it must not carry; and the checks a fresh server installation of the tarball must pass.

## Interface constants

### package.json fields

| Field                    | Value                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `name`                   | `signalk-questdb-history-provider`                                                                                     |
| `version`                | `2.0.1` at the time of writing. A release increments it.                                                               |
| `type`                   | `module`                                                                                                               |
| `main`                   | `dist/index.js`                                                                                                        |
| `keywords`               | `["signalk-node-server-plugin", "signalk-category-database"]`                                                          |
| `signalk.displayName`    | DISPLAY_NAME. The value is chosen later. The same value goes into the factory `name` field and into the README.        |
| `signalk.appIcon`        | `app-icon.svg`                                                                                                         |
| `signalk.requires`       | absent                                                                                                                 |
| `engines.node`           | `>=22`                                                                                                                 |
| `license`                | `MIT`                                                                                                                  |
| `author`                 | `Matti Airas <matti.airas@hatlabs.fi>`                                                                                 |
| `contributors`           | absent                                                                                                                 |
| `repository`             | `{ "type": "git", "url": "https://github.com/halos-org/signalk-questdb-history-provider" }`                            |
| `bugs.url`               | `https://github.com/halos-org/signalk-questdb-history-provider/issues`                                                 |
| `homepage`               | `https://github.com/halos-org/signalk-questdb-history-provider#readme`                                                 |
| `description`            | Free text. Chosen together with DISPLAY_NAME.                                                                          |
| `scripts.build`          | `tsc`                                                                                                                  |
| `scripts.test`           | Runs the compiled test suite against the built output; the layout of the compiled tests is the implementation's choice |
| `scripts.prepublishOnly` | `npm run build`                                                                                                        |

### Keywords that must be absent

| Keyword                       | Effect if present                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `signalk-plugin-configurator` | The Admin UI loads a plugin-supplied configuration panel instead of rendering the configuration schema as a form. |
| `signalk-embeddable-webapp`   | The Admin UI lists the package as a webapp.                                                                       |

### Plugin identity

| Item                                                     | Value                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Plugin id (the `id` field of the constructed plugin)     | `signalk-questdb-history-provider`                                      |
| Plugin name (the `name` field of the constructed plugin) | DISPLAY_NAME                                                            |
| Built module that exposes the plugin id                  | `dist/plugin-id.js`, named export `PLUGIN_ID`, equal to the plugin id   |
| Plugin configuration file the server reads               | `<config dir>/plugin-config-data/signalk-questdb-history-provider.json` |
| Environment variable that sets the server config dir     | `SIGNALK_NODE_CONFIG_DIR`                                               |

### Top-level configuration schema keys

The configuration schema is a JSON Schema object with `"type": "object"`. Its `properties` object has exactly these keys and no others:

| Key                   |
| --------------------- |
| `questdbHost`         |
| `questdbIlpPort`      |
| `questdbHttpPort`     |
| `pathFilter`          |
| `samplingRates`       |
| `defaultSamplingRate` |
| `recordSelf`          |
| `recordOthers`        |
| `retentionDays`       |

The type, title, default, and description of each key belong to the configuration surface.

### Server URLs

| URL                                              | Meaning                                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/signalk-questdb-history-provider/app-icon.svg` | Where the Admin UI fetches the icon. The server serves the package `public/` directory at `/<package name>/`, and the Admin UI builds `/<package name>/<signalk.appIcon>`. |
| `GET /skServer/plugins`                          | JSON array of loaded plugins. Each element has an `id` field.                                                                                                              |
| `GET /signalk/v2/api/history/_providers`         | JSON listing of registered history providers.                                                                                                                              |
| `GET /signalk/v1/api/`                           | Used only as the server readiness probe.                                                                                                                                   |

### Files in the tarball

| Category        | Paths                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Must be present | `package.json`, `dist/index.js` (the `main` file) with every module it imports, `dist/plugin-id.js`, `public/app-icon.svg`, `README.md`, `LICENSE` |
| Must be absent  | any path under `src/`; any browser bundle                                                                                                          |

### Continuous integration constants

| Item                                    | Value                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Node versions                           | `22`, `24`                                                                                                          |
| Server package                          | `signalk-server@latest`                                                                                             |
| QuestDB image                           | `questdb/questdb:10.0.0`                                                                                            |
| QuestDB ports published to the job      | `9000`, `9009`, `8812`                                                                                              |
| QuestDB readiness probe                 | `GET http://localhost:9000/`, up to 60 attempts, 2 s apart                                                          |
| Pack command                            | `npm pack --ignore-scripts --pack-destination /tmp`                                                                 |
| Server start command                    | `npx signalk-server --sample-nmea0183-data --sample-n2k-data --override-timestamps -p 3000`                         |
| Server readiness probe                  | `GET http://localhost:3000/signalk/v1/api/`, up to 60 attempts, 2 s apart                                           |
| Plugin listing check                    | `GET http://localhost:3000/skServer/plugins`, once                                                                  |
| Provider registration check             | `GET http://localhost:3000/signalk/v2/api/history/_providers`, up to 30 attempts, 2 s apart                         |
| Job timeout                             | 15 minutes                                                                                                          |
| Plugin configuration written by the job | `{"enabled": true, "configuration": {"questdbHost": "127.0.0.1", "questdbHttpPort": 9000, "questdbIlpPort": 9009}}` |

## Behaviour

### Identity

1. The package name and the plugin id are the same string: `signalk-questdb-history-provider`.
2. The plugin id is declared in the plugin code. The server does not derive it from the package name. The built package exposes the id as the named export `PLUGIN_ID` of `dist/plugin-id.js`, so a caller can read it without constructing the plugin or starting the server. The server uses the id as the name of the plugin configuration file, as the key it lists under `/skServer/plugins`, and as the key under which the plugin registers as a history provider.
3. The plugin `name` field and `signalk.displayName` carry DISPLAY_NAME. The Admin UI shows `signalk.displayName` in the App Store and in the plugin list.

### Discovery and listing

4. The server discovers a plugin by scanning the packages installed in its data directory for a `package.json` whose `keywords` array contains `signalk-node-server-plugin`. Without that keyword the server does not load the package.
5. The App Store lists packages that carry `signalk-node-server-plugin` on the npm registry. The keyword `signalk-category-database` places the package in the store's database category.
6. The `keywords` array does not contain `signalk-plugin-configurator`. The schema form rendered by the Admin UI is the whole configuration surface.
7. The `keywords` array does not contain `signalk-embeddable-webapp`. The package ships no webapp.
8. `signalk.requires` is absent. `dependencies` and `peerDependencies` name no other Signal K plugin. The App Store therefore shows no required-plugin card for this package.
9. Signal K server 2.19 or newer is required: that is when the v2 History API and its provider registration call arrived.

### Loading

10. The server loads the plugin by calling Node's `require` on the package directory and taking the `default` property of the result when it exists, otherwise the result itself. `require` resolves the directory through the `main` field.
11. `type` is `module`, so Node loads `dist/index.js` and every module it imports as ES modules. Every relative import in the emitted code carries its `.js` extension; Node rejects an extensionless specifier at load time.
12. Because the server reaches the module through `require`, the module graph must contain no top-level `await`. Node refuses to `require` an ES module that uses it.
13. The `default` export is a function. The server calls it once with its plugin application object and receives the plugin object.
14. Calling the factory performs no I/O and calls no method of the application object. The call succeeds with an application object that has only `debug`, `error`, and `setPluginStatus`.
15. The returned plugin object has these fields: `id` (string, the plugin id), `name` (string, DISPLAY_NAME), `schema`, `start` (function), `stop` (function). `start` receives the stored configuration object. The server does not await `start`.
16. `schema` is a JSON Schema object. The server also accepts a function that returns the object; both forms are acceptable. The object has `"type": "object"` and a `properties` object whose keys are exactly the nine top-level configuration keys.
17. `engines.node` is `>=22`. Node 22 is the oldest line on which the server performs the `require` of rule 10 for an ES module without a command-line flag (Node 22.12 and newer, and Node 20.19 and newer, have that support).

### Icon

18. `signalk.appIcon` is a bare filename with no `./` or `/` prefix. The Admin UI interpolates it into `/<package name>/<appIcon>`, and a prefixed value produces a URL the server does not serve. The card then renders blank.
19. The file named by `signalk.appIcon` exists at `public/<appIcon>` in the repository and in the tarball. The server serves the package `public/` directory; a file elsewhere in the package is not served.

### Tarball contents

20. `npm pack` includes the `main` file and every module it imports, `public/app-icon.svg`, `package.json`, `README.md`, and `LICENSE`.
21. `npm pack` includes no path under `src/`.
22. `npm pack` includes no browser bundle. `dependencies` and `devDependencies` name no UI framework and no bundler.
23. A file present on disk is not evidence that the tarball carries it. Checks about the tarball read `npm pack --dry-run --json` rather than the working tree.
24. `prepublishOnly` runs the build, so a publish from a clean checkout produces `dist/` before packing.

### Test script

25. `npm test` runs the compiled test suite against the built output. The Signal K plugin registry runs `npm test` in a sandbox with no network and a read-only home directory. Any test that invokes `npm` passes `--offline` and a `--cache` directory under the system temporary directory, and removes that directory afterwards; a write to the default cache under the home directory fails there and the whole suite reports as failing.

### Installation as the operator sees it

26. The package is on npm under its package name. In the Admin UI the operator opens **Apps & Plugins -> Store**, searches for DISPLAY_NAME, installs, and restarts the server when prompted. Servers older than 2.27 name the same two pages **Appstore** and **Server -> Plugin Config**.
27. Alternatively the operator runs `npm install signalk-questdb-history-provider` in the server data directory (`~/.signalk` by default).
28. After a restart the plugin appears under **Apps & Plugins -> Configuration**. It is disabled until the operator enables it.

### Continuous integration checks

The integration job runs on every pull request to `main`, every push to `main`, and on manual dispatch, once per Node version in the matrix. Each run performs these steps in order, and every step must succeed:

29. Start the QuestDB service container and wait until `GET http://localhost:9000/` answers.
30. Install dependencies, run the build, and run `npm pack --ignore-scripts`. The build must succeed without the pack step running any lifecycle script.
31. Create an empty directory, run `npm init -y` in it, install `signalk-server@latest`, and install the packed tarball from its path. Both installs must succeed.
32. Read the plugin id by loading `dist/plugin-id.js` from the installed package and taking its `PLUGIN_ID` export. The job does not assume the id equals the package name. Write `plugin-config-data/<plugin id>.json` under that directory with the configuration listed in the constants table.
33. Start the server from that directory with `SIGNALK_NODE_CONFIG_DIR` pointing at it, on port 3000, with the built-in NMEA 0183 and NMEA 2000 sample data and overridden timestamps, so deltas flow. Wait until `GET /signalk/v1/api/` answers.
34. `GET /skServer/plugins` must return a listing that contains the plugin id. Otherwise the job fails with the server log attached.
35. Poll `GET /signalk/v2/api/history/_providers` until its body contains the plugin id. Registration happens only after QuestDB answers and the tables exist, so the poll allows 30 attempts, 2 s apart. If the id never appears the job fails with the last body and the server log attached.
36. Stop the server. A separate status job requires the matrix result to be `success`; a skipped or cancelled matrix fails it.

## Cross-surface references

- Plugin id `signalk-questdb-history-provider`: the `id` field of the plugin object, the stem of the server's config file for the plugin, and the key under which the plugin appears in `/skServer/plugins` and `/signalk/v2/api/history/_providers`. The plugin emits no deltas and no notifications.
- `dist/plugin-id.js` with named export `PLUGIN_ID`: the lifecycle surface and the CI job read the plugin id from it.
- DISPLAY_NAME: the plugin `name` field, `signalk.displayName`, and the README search instruction.
- The nine top-level configuration keys: the configuration surface defines their types, titles, defaults, and descriptions.
- QuestDB default ports `9000` (HTTP) and `9009` (ILP) and default host `127.0.0.1`: the configuration surface defines them as defaults; the CI job passes them explicitly.
- Provider registration under `/signalk/v2/api/history/_providers` after QuestDB is healthy and the tables exist: the lifecycle surface defines the wait and the table creation.

## Disagreements with the README

- The README Installing section tells the operator to search the store for the current display name. This specification leaves the display name as DISPLAY_NAME; the README must carry the chosen value.

## Observed defects

- `engines.node` is `>=22`, but Node 22.0 through 22.11 refuse to `require` an ES module without `--experimental-require-module`, so the server cannot load the plugin on those releases even though npm accepts the install.
- The tarball carries the compiled test files, repository documentation, and any untracked directory in the working tree; none of these serve the server.

## Test cases

### Package manifest and tarball

| Input / state                | Action                                                                     | Expected outcome                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Built package on disk        | Read `package.json` `main`                                                 | The file it names exists.                                                                                              |
| Built package on disk        | Run `npm pack --dry-run --json --offline` with a temporary cache directory | The manifest contains the `main` file.                                                                                 |
| Built package on disk        | Run `npm pack --dry-run --json --offline`                                  | No manifest path starts with `src/`.                                                                                   |
| Built package on disk        | Run `npm pack --dry-run --json --offline`                                  | No manifest path is a browser bundle.                                                                                  |
| `package.json`               | Read `dependencies` and `devDependencies`                                  | No entry is a UI framework or a bundler.                                                                               |
| `package.json`               | Read `type`                                                                | The value is `module`.                                                                                                 |
| `package.json`               | Read `keywords`                                                            | Contains `signalk-node-server-plugin`. Contains neither `signalk-plugin-configurator` nor `signalk-embeddable-webapp`. |
| `package.json`               | Read `signalk.requires`, `dependencies`, `peerDependencies`                | `signalk.requires` is absent. No dependency or peer dependency is another Signal K plugin.                             |
| `package.json`               | Read `signalk.appIcon`                                                     | The value is set, and starts with neither `./` nor `/`.                                                                |
| `package.json` and `public/` | Look up `public/<appIcon>`                                                 | The file exists on disk.                                                                                               |
| Built package on disk        | Run `npm pack --dry-run --json --offline`                                  | The manifest contains `public/<appIcon>`.                                                                              |

### Loading the entry point

| Input / state         | Action                                                                       | Expected outcome                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built package on disk | `require` the package directory                                              | The `default` export, or the module itself when there is no `default`, is a function.                                                                                                                 |
| Factory function      | Call it with an object that has only `debug`, `error`, and `setPluginStatus` | Returns an object whose `id` equals `signalk-questdb-history-provider`, whose `name` is a string, and whose `start` and `stop` are functions.                                                         |
| Constructed plugin    | Read `schema`; call it when it is a function                                 | `type` is `object`, and `properties` has `questdbHost`, `questdbIlpPort`, `questdbHttpPort`, `pathFilter`, `samplingRates`, `defaultSamplingRate`, `recordSelf`, `recordOthers`, and `retentionDays`. |
| Constructed plugin    | Read `schema.properties`                                                     | It has no key other than the nine listed.                                                                                                                                                             |

### Fresh server installation

| Input / state                                                                                                                                    | Action                                                                      | Expected outcome                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Clean checkout, Node 22 or 24                                                                                                                    | Install dependencies, build, `npm pack --ignore-scripts`                    | A tarball is produced.                                           |
| Empty directory with `signalk-server@latest` installed                                                                                           | `npm install <tarball path>`                                                | The install succeeds.                                            |
| Installed package                                                                                                                                | Load `dist/plugin-id.js` and read `PLUGIN_ID`                               | The value is `signalk-questdb-history-provider`; no server runs. |
| Plugin configuration file with `enabled: true` and the QuestDB host and ports, `SIGNALK_NODE_CONFIG_DIR` set, QuestDB answering on 9000 and 9009 | Start the server with sample data on port 3000                              | `GET /signalk/v1/api/` answers within 60 attempts, 2 s apart.    |
| Server running                                                                                                                                   | `GET /skServer/plugins`                                                     | The body contains the plugin id.                                 |
| Server running, deltas flowing                                                                                                                   | Poll `GET /signalk/v2/api/history/_providers`, up to 30 attempts, 2 s apart | The body contains the plugin id within the poll window.          |
