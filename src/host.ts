export interface ManagerHost {
  readonly kind: 'browser' | 'desktop';
  readonly transport: 'not-configured';
}

declare global {
  interface Window { managerHost?: ManagerHost }
}

export function currentHost(): ManagerHost {
  return window.managerHost ?? Object.freeze({ kind: 'browser', transport: 'not-configured' });
}
