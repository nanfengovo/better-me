import http from "node:http";

function post(action, input) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ action, input });
    const req = http.request("http://localhost:5173/api/jd/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(body);
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log("Profiling live-batch-search...");
  const t0 = Date.now();
  const res = await post("live-batch-search", { keyword: "C#", regionId: "shanghai" });
  const t1 = Date.now();
  console.log(`live-batch-search returned in ${t1 - t0}ms`);
  console.log(`Providers:`, (res.results || []).map(r => `${r.platform}: ${r.status} (${r.cards?.length || 0} cards)`));
}

main().catch(console.error);
