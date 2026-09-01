module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
  maxWorkers: 2,
  globals: {
    'ts-jest': {
      isolatedModules: true,
      tsconfig: 'tsconfig.json'
    }
  }
};