// Función serverless de Vercel: reutiliza la app NestJS compilada en dist/ (npm run build).
module.exports = require('../dist/serverless.js').default;
