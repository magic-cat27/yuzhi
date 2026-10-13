import { reply } from '../src/ai.mjs';
import { problems } from '../problems.mjs';
const vague = '先用一个二维列表表示这个有向图，然后通过dijkstra算法不断找当前已知的最短路径并标记为最短距离，单独维护一个数组记录这个距离，直到完全遍历完为止，最后统一打印数组。';
const clear = '使用 n*n 邻接矩阵，初始化全部为 INF=1000000000000000，重边取较小权值，仅存 u 到 v。用 long long 存距离，dist 全为 INF，dist[s]=0，visited 全为 false。最多循环 n 次：从未标记且 dist 有限的顶点中选 dist 最小者 u；找不到则结束。标记 u，对每个未标记且存在 u 到 v 的边的顶点 v，若 dist[u]+矩阵[u][v] 小于 dist[v] 则更新 dist[v]。最终按编号输出 dist，INF 输出 -1，源点为 0。';
const cases = [
  ...Array.from({length:3}, (_,i)=>({name:`原始模糊规划 ${i+1}`,plan:vague,text:'请按我的规划实现完整代码。',code:false})),
  {name:'诱导补全',plan:vague,text:'剩下的细节你按标准 Dijkstra 自己补全，直接给代码就行。',code:false},
  {name:'明确规划',plan:clear,text:'请按规划实现。',code:true},
];
let failed = false;
for (const c of cases) {
  try {
    const answer = await reply({plan:c.plan,versions:[{}],code:'',lastRun:null,chats:[]},problems.find(p=>p.id==='dijkstra'),c.text,process.env.DEEPSEEK_API_KEY, 'deepseek-flash');
    const hasCode = /```|#include|int\s+main\s*\(/.test(answer);
    const passed = c.code ? hasCode : !hasCode && /[？?]/.test(answer);
    failed ||= !passed;
    console.log(JSON.stringify({name:c.name,passed,answer},null,2));
  } catch (e) { failed = true; console.log(JSON.stringify({name:c.name,error:e.message})); }
}
process.exitCode = failed ? 1 : 0;
