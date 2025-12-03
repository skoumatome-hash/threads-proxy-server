const express = require("express");
const { HttpsProxyAgent } = require("https-proxy-agent");
const axios = require("axios");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// ---------------------------------------------------------
//  プロキシ形式変換 (host:port:user:pass -> http://...)
// ---------------------------------------------------------
function formatProxy(proxyStr) {
  if (!proxyStr) return null;
  if (proxyStr.startsWith("http")) return proxyStr;
  const parts = proxyStr.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${user}:${pass}@${host}:${port}`;
  }
  return proxyStr;
}

// ---------------------------------------------------------
//  WEBブラウザ用ヘッダー生成 (sessionid一本勝負)
// ---------------------------------------------------------
function createWebHeaders(ua, sessionid, csrftoken, lsd = null) {
  // sessionidの%3Aなどをデコード
  const cleanSessionId = decodeURIComponent(sessionid);
  
  const headers = {
    'User-Agent': ua,
    'Cookie': `sessionid=${cleanSessionId}`, // 余計なものは混ぜない
    'x-ig-app-id': '238260118697367', // WEB版AppID
    'x-asbd-id': '129477',
    'Authority': 'www.threads.net',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://www.threads.net',
    'Referer': 'https://www.threads.net/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };

  if (csrftoken) {
    headers['x-csrftoken'] = csrftoken;
    headers['Cookie'] += `; csrftoken=${csrftoken}`;
  }
  
  if (lsd) {
    headers['x-fb-lsd'] = lsd;
  }
  
  return headers;
}

// ---------------------------------------------------------
//  LSDトークンとUserIDをページから取得
// ---------------------------------------------------------
async function fetchPageData(username, agent, headers) {
  try {
    const response = await axios.get(`https://www.threads.net/@${username}`, {
      httpsAgent: agent,
      headers: headers,
      proxy: false,
      validateStatus: s => s < 500
    });
    
    const html = response.data;
    
    // LSDを探す
    const lsdMatch = html.match(/"LSD",\[\],{"token":"(.*?)"}/);
    const lsd = lsdMatch ? lsdMatch[1] : null;

    // UserIDを探す (ds_user_idがクッキーになくてもページから拾う)
    const userIdMatch = html.match(/"user_id":"(\d+)"/);
    const userId = userIdMatch ? userIdMatch[1] : null;

    return { lsd, userId };
  } catch (e) {
    console.error("ページ取得エラー:", e.message);
    return { lsd: null, userId: null };
  }
}

// 1. ログイン確認
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, ua, proxy } = req.body; // I2の値を fullCookie として受け取る
  console.log(`[Login Check] ${username}`);

  if (!proxy || !fullCookie) return res.status(400).json({ status: "error", message: "情報不足" });

  try {
    const formattedProxy = formatProxy(proxy);
    const proxyAgent = new HttpsProxyAgent(formattedProxy);
    
    // I2セルの中身をそのまま sessionid として扱う
    const sessionid = fullCookie.trim(); 

    // まずページにアクセスして生存確認
    // (CSRFトークンは初回は無くてもGETなら通ることが多い)
    const headers = createWebHeaders(ua, sessionid, null);
    const { lsd, userId } = await fetchPageData(username, proxyAgent, headers);

    if (lsd) {
      res.json({ status: "success", message: `★ログイン成功！ (LSD取得OK)` });
    } else {
      res.status(403).json({ status: "error", message: "ページにアクセスできませんでした(403)。Cookieが無効かプロキシ拒否。" });
    }

  } catch (error) {
    console.error(`[Login Check] エラー: ${error.message}`);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// 2. 予約受付
app.post("/api/enqueue", (req, res) => {
  const { username, fullCookie, text, deviceId, imageUrl, ua, proxy } = req.body;
  requestQueue.push({ username, fullCookie, text, deviceId, imageUrl, ua, proxy });
  console.log(`[受付] ${username}`);
  res.json({ status: "queued", message: "予約完了" });
  processQueue();
});

// 3. 処理ワーカー
async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始: ${task.username} ---`);

    try {
      const formattedProxy = formatProxy(task.proxy);
      const proxyAgent = new HttpsProxyAgent(formattedProxy);
      
      // I2セルの値をsessionidとして使用
      const sessionid = task.fullCookie.trim();

      // 1. LSDとUserIDを取得
      let headers = createWebHeaders(task.ua, sessionid, null);
      const { lsd, userId } = await fetchPageData(task.username, proxyAgent, headers);
      
      if (!lsd) throw new Error("LSDトークン取得失敗");
      if (!userId) throw new Error("UserID取得失敗");

      console.log(`準備OK: LSD=${lsd.substring(0,5)}..., UserID=${userId}`);

      // 2. 投稿 (GraphQL)
      headers = createWebHeaders(task.ua, sessionid, null, lsd);
      headers['x-fb-friendly-name'] = 'BarcelonaCreatePostMutation';

      const postPayload = new URLSearchParams();
      postPayload.append('lsd', lsd);
      postPayload.append('variables', JSON.stringify({
        userID: userId,
        text: task.text,
        publicationOpt: "any_user",
        attachmentUtils: null
      }));
      postPayload.append('doc_id', '23980155133315596');

      const response = await axios.post("https://www.threads.net/api/graphql", postPayload, {
        httpsAgent: proxyAgent,
        headers: headers,
        proxy: false
      });

      if (response.data.errors) {
         console.error("GraphQLErrors:", JSON.stringify(response.data.errors));
      } else {
         console.log(`✅ 投稿成功: ${task.username}`);
      }

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
      if (error.response) console.log(JSON.stringify(error.response.data));
    }

    if (requestQueue.length > 0) {
      console.log("☕ 休憩中 (25秒)...");
      await new Promise((resolve) => setTimeout(resolve, 25000));
    }
  }
  isProcessing = false;
}

const listener = app.listen(process.env.PORT, () => {
  console.log("Server started");
});
