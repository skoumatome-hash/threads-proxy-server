/**
 * 100垢運用専用：行列のできるThreads投稿サーバー
 * - GASからのリクエストを「受付」だけして即レス
 * - 裏で1件ずつ処理し、完了ごとに25秒休憩（IPローテーション待ち）
 */

const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const app = express();

app.use(express.json());

// ▼▼▼ ここにあなたの5Gプロキシ情報を入れてください ▼▼▼
// 形式: http://ユーザー名:パスワード@ホスト:ポート
const PROXY_URL = "http://86a4c5a5d75ab064cd33__cr.jp:ae68af898d6ead3b@gw.dataimpulse.com:823"; 
// ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

// 待ち行列（キュー）
const requestQueue = [];
let isProcessing = false;

// 1. GASからの受付口
app.post("/api/enqueue", (req, res) => {
  const { username, password, text, deviceId, imageUrl, replyToId } = req.body;

  // 必要な情報がない場合は弾く
  if (!username || !password || !text) {
    return res.status(400).json({ status: "error", message: "情報不足" });
  }

  // 行列に並ばせる
  requestQueue.push({ username, password, text, deviceId, imageUrl, replyToId });
  console.log(`[受付] ${username} を予約リストに追加 (現在待ち: ${requestQueue.length}件)`);

  // GASには「OK、預かったよ」とだけ返す（これでGASはタイムアウトしない）
  res.json({ status: "queued", message: "予約完了" });

  // 処理開始（すでに動いていれば無視）
  processQueue();
});

// 2. 順番処理ワーカー（ここが心臓部）
async function processQueue() {
  if (isProcessing) return;
  if (requestQueue.length === 0) return;

  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift(); // 先頭を取り出す
    console.log(`\n--- 処理開始: ${task.username} ---`);

    try {
      // プロキシエージェント作成（リクエスト毎に作成して接続をリフレッシュ）
      const proxyAgent = new HttpsProxyAgent(PROXY_URL);

      // Threadsクライアント作成
      const threadsAPI = new ThreadsAPI({
        username: task.username,
        password: task.password,
        deviceID: task.deviceId, // スプシで固定したID
        axiosConfig: {
          httpAgent: proxyAgent,
          httpsAgent: proxyAgent, // ここでプロキシを通す
        },
      });

      // 投稿オプション作成
      const publishOptions = { text: task.text };
      if (task.imageUrl) publishOptions.image = task.imageUrl;
      if (task.replyToId) publishOptions.replyToId = task.replyToId; // ツリー投稿対応

      // 投稿実行！
      await threadsAPI.publish(publishOptions);
      console.log(`✅ 投稿成功: ${task.username}`);

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
    }

    // ★重要：IPローテーション待ち時間
    // 5GプロキシのIPが変わる時間を確保（安全を見て25秒）
    if (requestQueue.length > 0) {
      console.log("☕ 休憩中... (25秒後に次のアカウントを処理)");
      await new Promise((resolve) => setTimeout(resolve, 25000));
    }
  }

  isProcessing = false;
  console.log("\n🎉 すべての予約処理が完了しました");
}

// サーバー起動
const listener = app.listen(process.env.PORT, () => {
  console.log("Your app is listening on port " + listener.address().port);
});
