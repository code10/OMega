const LEVELS: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

function getConfiguredLevel() {
  const raw = (process.env.OM_LOG_LEVEL || 'info').toLowerCase().trim();
  return LEVELS[raw] ?? LEVELS.info;
}

export function createLogger(scope = 'OMega') {
  const format = (level: string, msg: string, meta?: any) => {
    const ts = new Date().toISOString();
    const base = `[${ts}] [${level.toUpperCase()}] [${scope}] ${msg}`;
    if (meta === undefined) return base;
    try {
      return `${base} ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`;
    } catch (_) {
      return base;
    }
  };

  return {
    debug(msg: string, meta?: any) {
      if (getConfiguredLevel() <= LEVELS.debug) {
        console.debug(format('debug', msg, meta));
      }
    },
    info(msg: string, meta?: any) {
      if (getConfiguredLevel() <= LEVELS.info) {
        console.log(format('info', msg, meta));
      }
    },
    warn(msg: string, meta?: any) {
      if (getConfiguredLevel() <= LEVELS.warn) {
        console.warn(format('warn', msg, meta));
      }
    },
    error(msg: string, meta?: any) {
      if (getConfiguredLevel() <= LEVELS.error) {
        console.error(format('error', msg, meta));
      }
    }
  };
}

export const logger = createLogger('OMega');

