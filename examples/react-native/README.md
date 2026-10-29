# React Native: a chat with Expo

The tutorial's chat on iOS and Android: `bunvex/messages.ts` has a query (`list`) and a mutation (`send`), and
`App.tsx` renders the messages with `useQuery` from `@bunvex/react`, as a web app does. Nothing in bunvex is
specific to React Native: the same client and hooks run on it, as Convex's do. Expo SDK 58 (React Native 0.88).

## Run it on the iOS simulator

You need Xcode with an iOS simulator installed (on a Mac).

```sh
cd examples/react-native
bun install
bun run dev        # starts a local deployment, pushes the functions, then `expo start --ios`
```

`bun run dev` is `bunvex dev`: it writes the deployment's URL to `.env.local` as `EXPO_PUBLIC_BUNVEX_URL` (the
`EXPO_PUBLIC_` prefix because the app depends on `expo`), which Expo inlines into the app. Open the app on two
simulators, or on the simulator and in Expo Go, and talk to yourself.

The local deployment listens on `127.0.0.1`, which the iOS simulator shares with your Mac. The Android emulator
and a physical device do not: point `EXPO_PUBLIC_BUNVEX_URL` at an address they can reach (the emulator sees your
Mac as `10.0.2.2`; a device needs your Mac's address on the network, and a backend listening on it).

## What is specific to this repository

- `babel.config.js`: in the monorepo the `@bunvex/*` packages are TypeScript sources, and Babel needs
  `allowDeclareFields` for them. An app that installs `@bunvex/*` from npm gets compiled JavaScript and keeps
  Expo's default Babel config.
- `polyfills.ts`: adds `TextDecoder` if the JavaScript runtime has none, with a warning in Metro's log, so this
  example shows whether React Native needs it.
- Metro needs no configuration: Expo sets it up for monorepos itself.

## Test

`test/e2e.test.ts` deploys the functions to a fresh backend and checks the chat through the client, then bundles
the app for iOS with `expo export` and checks the bundle holds nothing of the server. The app itself runs on a
simulator or a device, which CI does not have.
