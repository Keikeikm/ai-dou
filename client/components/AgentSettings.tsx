import { useEffect, useRef, useState } from 'react';
import { checkAgent, joinAgent, providerConfiguration, updateKey } from '../api/client.js';
import { errorLabels } from '../domain/presentation.js';
import type { AgentRegistration, DeepSeekCheckResult, ProviderConfig, Room } from '../domain/types.js';
import { strategySkills, type SkillId } from '../../shared/strategy-skills.js';

export function ProviderPanel() {
  const [config, setConfig] = useState<ProviderConfig>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void providerConfiguration(controller.signal).then(setConfig).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [revision]);
  return <section className="deepseek-panel" aria-label="DeepSeek 服务配置"><strong>DeepSeek 模型</strong>
    <span>{config ? config.model + ' · ' + (config.hasServerKey ? '服务端共享密钥已配置' : '服务端未配置共享密钥') + ' · 超时 ' + config.turnTimeoutMs / 1000 + ' 秒' : '正在查询服务配置…'}</span>
    <button onClick={() => setRevision((value) => value + 1)}>刷新配置</button><a href="/deepseek" target="_blank" rel="noopener">配置说明</a>
    <p>{error || '已配置不代表已验证。模型对局会产生 API 费用；开局前可以确认一次连接测试，不会自动调用模型。修改 .env 后需重启后端。'}</p>
  </section>;
}

export function Registration({ room, reload }: { room: Room; reload: () => void }) {
  const [name, setName] = useState('我的 Agent');
  const [kind, setKind] = useState<AgentRegistration['kind']>('random');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [skill, setSkill] = useState<SkillId | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (room.status !== 'waiting') return null;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const registration: AgentRegistration = { name, kind, ...(kind === 'http' ? { api_url: url, api_key: key || null } : kind === 'deepseek' ? { api_key: key || null, ...(skill ? { skill } : {}) } : {}) };
    setKey('');
    setBusy(true);
    setError('');
    try { await joinAgent(room.id, registration); reload(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '入座失败'); }
    finally { setBusy(false); }
  }
  return <form className="join-panel" aria-label="Agent 入座" onSubmit={(event) => void submit(event)}>
    <label htmlFor="agent-name">Agent 名称</label><input id="agent-name" value={name} maxLength={32} required onChange={(event) => setName(event.target.value)} />
    <label htmlFor="agent-kind">策略</label><select id="agent-kind" value={kind} onChange={(event) => { setKind(event.target.value as AgentRegistration['kind']); setKey(''); }}>
      <option value="random">随机 Bot</option><option value="greedy">贪心 Bot</option><option value="http">外部 HTTP Agent</option><option value="deepseek">DeepSeek 模型</option><option value="human" disabled={room.players.some((player) => player.kind === 'human')}>真人玩家（自己）</option>
    </select><button disabled={busy || room.players.length >= 3}>加入房间</button><span>{room.players.length}/3 席位</span>
    {kind === 'deepseek' && <div className="agent-http-fields"><label htmlFor="agent-skill">打牌 skill</label>
      <select id="agent-skill" value={skill} disabled={busy} onChange={(event) => setSkill(event.target.value as SkillId | '')}>
        <option value="">自动按席位分配不同策略</option>{strategySkills.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.description}</option>)}
      </select><span>策略随身份切换地主 / 农民战术；每回合仍只请求一次模型，入座后本局固定。</span></div>}
    {(kind === 'http' || kind === 'deepseek') && <div className="agent-http-fields">{kind === 'http' && <><label htmlFor="agent-url">Agent API 地址</label><input id="agent-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://127.0.0.1:8787/decide" /></>}
      <label htmlFor="agent-key">API key</label><input id="agent-key" type="password" autoComplete="off" maxLength={2048} value={key} onChange={(event) => setKey(event.target.value)} placeholder={kind === 'deepseek' ? '留空使用服务端共享密钥' : '可选，仅发送至服务端'} />
      <span>密钥只写不读，入座后清空输入；只向 Agent 发送自己的手牌和公开历史。</span></div>}{error && <p role="alert">{error}</p>}
  </form>;
}

export function KeySettings({ room, reload }: { room: Room; reload: () => void }) {
  const players = room.players.filter((player) => ['deepseek', 'http'].includes(player.kind));
  const [selected, setSelected] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [checks, setChecks] = useState<Record<string, DeepSeekCheckResult>>({});
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const player = players.find((candidate) => candidate.id === selected) ?? players[0];
  const enabled = ['waiting', 'ready'].includes(room.status);
  if (!players.length || !enabled) return null;
  async function save(clear: boolean) {
    if (!player || busy) return;
    const apiKey = clear ? null : key;
    setKey('');
    setBusy(true);
    setMessage('');
    try { await updateKey(room.id, player.id, apiKey); setChecks({}); setMessage(clear ? '席位密钥已清除，DeepSeek 仍可使用服务端共享密钥' : '密钥已替换，需要重新测试连接'); reload(); }
    catch (failure) { setMessage(failure instanceof Error ? failure.message : '密钥更新失败'); }
    finally { setBusy(false); }
  }
  async function check() {
    if (!player || busy || player.kind !== 'deepseek' || !player.hasApiKey) return;
    if (!window.confirm('将使用所选席位的已保存密钥发送 1 次 DeepSeek 模拟请求，可能产生少量 API 费用。不推进牌局、不计分、无自动重试。是否继续？')) return;
    setBusy(true);
    setMessage('正在进行一次连接测试…');
    controller.current = new AbortController();
    try { const result = await checkAgent(room.id, player.id, controller.current.signal); setChecks((values) => ({ ...values, [player.id]: result })); setMessage(''); }
    catch (failure) { if (!controller.current.signal.aborted) setMessage(failure instanceof Error ? failure.message : '测试失败'); }
    finally { setBusy(false); }
  }
  const result = player ? checks[player.id] : undefined;
  return <details className="agent-key-panel"><summary>Agent 密钥管理与测试 · 仅开局前可操作</summary><div className="agent-key-controls">
    <label htmlFor="key-player">Agent</label><select id="key-player" value={player?.id ?? ''} disabled={busy} onChange={(event) => { setSelected(event.target.value); setKey(''); setMessage(''); }}>
      {players.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.hasApiKey ? '已配置密钥' : '无密钥'}</option>)}
    </select><label htmlFor="replacement-key">新 API key</label><input id="replacement-key" type="password" autoComplete="off" value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} placeholder="密钥只写不读，不会回显" />
    <button disabled={busy || !key} onClick={() => void save(false)}>替换密钥</button><button disabled={busy} onClick={() => void save(true)}>清除密钥</button>
    <button disabled={busy || player?.kind !== 'deepseek' || !player.hasApiKey} onClick={() => void check()}>测试一次 DeepSeek 连接</button>
    <p role="status">{message || (result ? result.verified ? '连接验证成功 · ' + result.durationMs + ' ms' : errorLabels[result.error ?? 'connection_failed'] : '未测试连接；已配置不代表已验证，测试不推进牌局或计分。')}</p>
  </div></details>;
}
