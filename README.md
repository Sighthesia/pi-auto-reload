# Pi extensions

Personal [Pi](https://github.com/earendil-works/pi) extension packages.

| Package | What it does |
| --- | --- |
| [`@sighthesia/pi-auto-reload`](packages/pi-auto-reload) | Reloads extensions, skills, prompts and keybindings on your next message, right before they are used — never on a timer, never mid-run. |

## Install

```sh
pi install npm:@sighthesia/pi-auto-reload
```

Or from git, before a release:

```sh
pi install git:github.com/Sighthesia/pi-extensions@main
```

## Layout

```text
packages/<name>/
├── package.json      # `pi` manifest + `pi-package` keyword
├── extensions/       # discovered by the manifest
├── README.md
├── CHANGELOG.md      # version headings Pi can show after an update
└── LICENSE
```

Each package follows the conventions in Pi's
[package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md):
host-provided packages such as `@earendil-works/pi-coding-agent` are declared as
`peerDependencies` with a `*` range and never bundled, so an installed package
cannot shadow Pi's own module instances.

## License

MIT
