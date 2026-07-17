const resolveFrom = require('resolve-from');

// Expo SDK 55 still loads the removed legacy TypeScript compiler API.
const resolveSilently = resolveFrom.silent;
resolveFrom.silent = (fromDirectory, moduleId) => {
  if (moduleId === 'typescript') {
    return require.resolve('typescript-expo-compat');
  }
  return resolveSilently(fromDirectory, moduleId);
};

require('expo/bin/cli');
