/**
 * src/shims.d.ts —— 宿主依赖的最小类型声明
 *
 * 真实包名（实测于 DSH 0.2.1-rc.2 的 node_modules）：
 *   @deepseek-ai/cordis
 *   @deepseek-ai/schemastery
 *
 * 这里只声明本插件实际用到的部分，保证 tsc 通过且不引入运行时耦合。
 */

declare module '@deepseek-ai/cordis' {
  /** cordis 应用上下文（仅声明本插件用到的成员） */
  export interface App {
    /** 宿主 HTTP 服务（路由注册） */
    server?: HttpFace;
    webserver?: HttpFace;
    logger?: {
      info?(msg: unknown): void;
      warn?(msg: unknown): void;
      error?(msg: unknown): void;
    };
    effect?(fn: () => unknown, label?: string): void;
    get?(name: string): unknown;
  }
  export interface HttpFace {
    get(path: string, handler: (req: any, res: any) => unknown): void;
    post(path: string, handler: (req: any, res: any) => unknown): void;
  }
}

declare module '@deepseek-ai/schemastery' {
  export interface Schema<T = any> {
    default(v: T): Schema<T>;
  }
  export interface Z {
    string(): Schema<string>;
    number(): Schema<number>;
    boolean(): Schema<boolean>;
    object<T extends Record<string, any>>(shape: T): Schema<T>;
  }
  const z: Z;
  export default z;
}
