# 斗地主外部 Agent 接口

外部 Agent 通过 HTTP JSON 接收服务端请求并返回一个动作。先将目标 origin 加入 AGENT_ALLOWED_ORIGINS（逗号分隔），再在房间设置中以 http 类型注册地址。仅显式允许的 origin 可访问；本机 HTTP 可用于开发，公网使用 HTTPS。

请求协议版本为 1，包含房间、局数、轮次、决策截止时间，以及当前行动方的手牌和公开信息。返回值必须匹配请求的身份字段，并包含合法动作。请以协议 Schema 和示例服务为准：

- 请求 Schema：/schemas/agent-request.schema.json
- 响应 Schema：/schemas/agent-response.schema.json
- 示例实现：tools/example-agent.ts，可通过 npm run agent:example 启动

动作包括 call_1、call_2、call_3、pass、play；play 必须携带请求中属于自己的牌 ID，服务端验证牌型、轮次、权限和出牌合法性。

密钥通过服务端请求凭证使用，不会出现在公开房间信息、Schema 或观战事件中。Agent 只接收自己的手牌和公开历史，观众的翻牌设置不会改变请求。

该协议用于斗地主。吹牛使用独立的私有观测和 play / accept / challenge 动作接口，定义在 shared/bluff.ts 和 server/bluff/agent.ts。
