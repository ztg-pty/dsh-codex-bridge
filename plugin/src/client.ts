/**
 * client.ts —— 浏览器入口
 *
 * ★ 协议来源：逐字实测 dsh-workbuddy-connect/lib/client.js（官方第三方插件）
 *
 * 必须对齐的完整协议：
 *   1. 模块导出四件套：apply / inject / name（/default）
 *      inject = ['slots', 'locale', 'remote', 'remote.session']
 *      —— slots 服务由 @deepseek-ai/dsh-client-ui-renderer 提供，
 *         所以 package.json 的 dsh.client.inject 必须包含它
 *   2. slots.register(options, Component)：组件是第二个参数
 *   3. 设置块：settings.section → 容器 entry id `plugin-settings`
 *      → 子槽 plugin-settings.item → item 的 id 用包名
 *   4. 容器声明 children: { [itemSlot]: { kind:'list', scope:'root' } }
 *   5. 卡片通过 options.inject: () => ({...}) 接收注入面（props）
 *   6. 侧边栏插件页：keyed 槽 plugins.bundle.config，key = 包名
 */
import React from 'react';
import { CodexBridgeSettings } from './client/SettingsPage';

const PACKAGE_NAME = 'dsh-codex-bridge';
const PLUGIN_SETTINGS_SECTION_ID = 'plugin-settings';
const PLUGIN_SETTINGS_ITEM_SLOT = 'plugin-settings.item';
const PLUGIN_MANAGER_SLOT = 'plugins.bundle.config';

export const name = 'dsh-codex-bridge-client';

/** ★ 与官方一致：client 必须导出 inject，宿主据此向 ctx 挂服务 */
export const inject = ['slots', 'locale', 'remote', 'remote.session'] as const;

export function apply(ctx: any): void {
  try {
    console.info('[codex-bridge] client apply 开始；slots:', typeof ctx.slots !== 'undefined', '| locale:', typeof ctx.locale !== 'undefined', '| remote:', typeof ctx.remote !== 'undefined');

    // 中文文案
    try {
      ctx.locale?.register?.('settings.codexBridge', {
        zh: { title: 'Codex 会话桥接' },
        en: { title: 'Codex Session Bridge' },
      });
    } catch { /* 忽略 */ }

    /**
     * 注入面：宿主把它的返回值 spread 进卡片 props（官方 renderSlot 机制）。
     * 稳定性契约：getSnapshot 必须返回同一引用，否则 React 无限重渲染。
     * 我们无动态状态，直接返回常量对象。
     */
    const cardInject = () => ({
      apiBase: '/plugins/dsh-codex-bridge',
    });

    const registerItem = () => {
      const r = ctx.slots.register({
        name: PLUGIN_SETTINGS_ITEM_SLOT,
        id: PACKAGE_NAME,
        order: 30,
        inject: cardInject,          // ← 官方同款：props 注入面
      }, CodexBridgeSettings);
      console.info('[codex-bridge] plugin-settings.item 已注册');
      return r;
    };

    const registerIntoSection = () => {
      ctx.slots.inject('settings.section', () => {
        console.info('[codex-bridge] settings.section 工厂执行（宿主槽位已就绪）');
        if (ctx.slots.entries('settings.section').some((e: any) => e.options?.id === PLUGIN_SETTINGS_SECTION_ID)) {
          console.info('[codex-bridge] 复用已有《插件设置》容器');
          return registerItem();
        }
        try {
          const results = [
            ctx.slots.register({
              name: 'settings.section',
              id: PLUGIN_SETTINGS_SECTION_ID,
              order: 900,
              label: () => '插件设置',
              children: {
                [PLUGIN_SETTINGS_ITEM_SLOT]: { kind: 'list', scope: 'root' },
              },
            }, PluginSettingsSection),
            registerItem(),
          ];
          console.info('[codex-bridge] 已创建《插件设置》容器 + 卡片');
          return results;
        } catch (e) {
          console.warn('[codex-bridge] 容器竞争失败，退化为直接挂卡片:', e);
          return registerItem();
        }
      });
    };

    registerIntoSection();

    // 侧边栏「插件」页 bundle 详情页（keyed 槽，key=包名）
    try {
      ctx.slots.inject(PLUGIN_MANAGER_SLOT, () => ctx.slots.register({
        name: PLUGIN_MANAGER_SLOT,
        key: PACKAGE_NAME,
        inject: () => cardInject(),
      }, CodexBridgeSettings));
      console.info('[codex-bridge] plugins.bundle.config 已注册（keyed）');
    } catch (e) {
      console.error('[codex-bridge] 插件管理页注册失败（不影响设置块）：', e);
    }
  } catch (e) {
    console.error('[codex-bridge] 设置页注册失败（宿主不受影响）：', e);
  }
}

/** 《插件设置》共享容器外壳 */
function PluginSettingsSection(props: any) {
  return React.createElement('section', { className: 'plugin-settings-section' }, props.children);
}

/**
 * ★ 关键：不能 export default。
 * 宿主 unwrapExports 逻辑是 `e = e.default ?? e`，
 * 一旦有 default 导出，就会取 default 对象而丢掉顶层 inject/name，
 * 导致 fiber 拿不到 inject 清单、永不激活。
 * 官方 workbuddy client 也只导出 apply/inject/name 三个具名成员（无 default）。
 */
