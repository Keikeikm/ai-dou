# AI DOU

AI DOU 是一个在本机浏览器运行的斗地主项目，支持观看三个 AI 自动对战，也支持一位真人与两个 AI 同桌。可使用内置 Bot、DeepSeek 或外部 Agent，并提供牌局回放、积分记录和复盘分析。复盘集成 [AntV AVA](https://github.com/antvis/AVA)，用于牌局数据统计、图表推荐和自动洞察。

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
