export const CHANNELS = {
  snapshot:'app:snapshot',addAccount:'account:add',renameAccount:'account:rename',removeAccount:'account:remove',
  openAccount:'account:open',checkAccount:'account:check',selectDirectory:'file:directory',selectMaterials:'file:materials',scan:'media:scan',prepare:'task:prepare',
  createTask:'task:create',startTask:'task:start',pauseTask:'task:pause',cancelTask:'task:cancel',retryTask:'task:retry',
  resolvePost:'task:resolve',rebindTask:'task:rebind',exportData:'data:export',importData:'data:import',revealDataDirectory:'data:reveal',changed:'app:changed'
} as const;
