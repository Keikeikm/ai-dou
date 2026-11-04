# AI DOU

AI DOU 是一个在本机浏览器运行的斗地主项目，支持观看三个 AI 自动对战，也支持一位真人与两个 AI 同桌。可使用内置 Bot、DeepSeek 或外部 Agent，并提供牌局回放、积分记录和复盘分析。复盘集成 [AntV AVA V4](https://github.com/antvis/AVA)，使用 JavaScript 引擎的 `source()` / `profile()` 统计牌局数据。

AVA 固定为正式版 [`4.0.0`](https://github.com/antvis/AVA/releases/tag/v4.0.0)。V4 已移除 V3 的 `DataFrame`、`Advisor` 和洞察提取接口；本地默认图表按指标与玩家数量选择，统计洞察使用项目内的 IQR、主要类别、变异系数与 Mann–Kendall 规则，无需密钥。

复盘已接入 V4 的原生 `recommend()`，由 DeepSeek 经现有服务端受控接口完成图表推荐与配置生成。支持该版本的全部 19 类图表：折线、柱状、条形、饼图 / 环图、面积、散点、双轴、直方、箱线、小提琴、雷达、漏斗、瀑布、水波进度、词云、韦恩、矩形树图、桑基和数据表。模型只选择图表与少量展示设置，图表数值由完整筛选数据重建；数据不足或类型不适用时会提示并保留基础图与文字回答。每条回答的文字可独立展开、折叠。

发送复盘问题会把当前筛选统计、问题和对话历史交给 DeepSeek；生成图表通常额外调用两次模型，界面用量包含这些调用。图表请求不发送隐藏牌面、随机种子或密钥。手动选择图表无需模型调用：占比、雷达、流向和类别交集使用动作 / 牌型次数；分布图使用原始数值记录；散点、双轴只配对同一玩家同一步的有效测量；手牌漏斗与增减瀑布图需选定一位玩家。原有基础图仍支持点击历史数据点跳转回放。

渲染使用固定版本 `@antv/gpt-vis@1.3.0` 的本地资源，在禁止网络连接的沙箱 iframe 中运行。未启用模型分析代码执行或 AVA 生成的 HTML。

角色素材来源见 [头像来源说明](client/public/avatars/README.md)。

## 下载安装

1. 安装 [Node.js](https://nodejs.org/) 22.13 或更新版本。
2. 在 [GitHub 仓库](https://github.com/Keikeikm/ai-dou) 点击 **Code → Download ZIP**，下载并解压；也可使用 Git：

   ```bash
   git clone https://github.com/Keikeikm/ai-dou.git
   ```

3. 在项目目录打开终端，安装依赖并启动：

   ```bash
   npm ci
   npm run ui
   ```

打开终端显示的地址（默认 [http://127.0.0.1:5173](http://127.0.0.1:5173)），即可在大厅选择 AI 观战或真人对战。

内置 Bot 无需密钥。使用 DeepSeek 时，启动前将 `.env.example` 复制为 `.env`，填写 `DEEPSEEK_API_KEY`；模型对战和复盘问答会消耗 API 额度。
