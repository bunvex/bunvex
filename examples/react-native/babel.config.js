// Expo's preset, plus one setting for this repository only. In the monorepo the @bunvex/* packages are their
// TypeScript sources, and their classes use `declare` fields, which Babel's TypeScript transform accepts only with
// `allowDeclareFields`. An app that installs @bunvex/* from npm gets their compiled JavaScript and needs none of
// this: its babel.config.js is Expo's default (or none at all).
const from = (name, dir) => require.resolve(name, { paths: [dir] });
const preset = from("babel-preset-expo", from("expo/package.json", __dirname));
const typescript = from("@babel/plugin-transform-typescript", preset);

const endsWith = (ext) => (file) => !!file && file.endsWith(ext);

module.exports = (api) => {
  api.cache(true);
  return {
    presets: [preset],
    overrides: [
      { test: endsWith(".ts"), plugins: [[typescript, { allowDeclareFields: true, allowNamespaces: true }]] },
      {
        test: endsWith(".tsx"),
        plugins: [[typescript, { allowDeclareFields: true, allowNamespaces: true, isTSX: true }]],
      },
    ],
  };
};
