# Pi extensions

Personal [Pi](https://github.com/earendil-works/pi) extension packages.

| Package | What it does |
| --- | --- |
| [`@sighthesia/pi-attention`](packages/pi-attention) | Notifies you when the agent needs an answer; reloads Pi's resources lazily on your next message instead of on a timer. |

## Install

```sh
pi install npm:@sighthesia/pi-attention
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
