import { cProblems } from './c-problems.mjs';
import { coreProblems } from './core-problems.mjs';
export const template = '';
const bank = [
  ...cProblems,
  {
    id: 'scheduler', number: '01', title: '先来先服务 · 进程调度模拟', course: '操作系统', difficulty: '基础', tags: ['进程调度', '结构体', '边界处理'],
    description: '实现一个先来先服务（FCFS）的单处理器调度模拟程序。输入若干进程的到达时间和执行时长，输出各进程的开始时间、完成时间和等待时间。请先独立规划数据组织方式和调度过程，再指挥 AI 完成实现。',
    input: '第一行是进程数 n（1 ≤ n ≤ 100）。接下来 n 行，每行三个整数：进程编号 pid、到达时间 arrival、执行时长 burst。编号互不相同，0 ≤ arrival ≤ 10000，1 ≤ burst ≤ 10000。输入不保证按到达时间排序。',
    output: '按实际调度顺序输出，每行包含 pid、start、finish、wait，整数间以一个空格分隔。按到达时间先后执行；到达时间相同时，按输入顺序执行。处理器空闲时等待下一进程到达。',
    sampleInput: '3\n1 0 4\n2 2 3\n3 10 2', sampleOutput: '1 0 4 0\n2 4 7 2\n3 10 12 0',
    notes: '思考：输入顺序与调度顺序不同怎么办？处理器出现空闲时，时间如何推进？',
  },
  {
    id: 'lru', number: '02', title: 'LRU · 页面置换模拟', course: '操作系统', difficulty: '进阶', tags: ['虚拟内存', '状态维护', '模拟'],
    description: '实现最近最少使用（LRU）页面置换模拟。给定物理页框数量和页面访问序列，逐次报告命中或缺页，并统计缺页次数。',
    input: '第一行是页框数 k 和访问次数 n（1 ≤ k ≤ 10，1 ≤ n ≤ 100）。第二行是 n 个非负页面编号，编号不超过 10000。所有页框初始为空。',
    output: '每次访问输出 HIT 或 MISS。最后一行输出缺页总次数。缺页时优先使用空页框，否则淘汰最近一次访问时间最早的页面；命中也需要更新访问时间。',
    sampleInput: '2 6\n1 2 1 3 1 2', sampleOutput: 'MISS\nMISS\nHIT\nMISS\nHIT\nMISS\n4',
    notes: '思考：如何表示空页框？命中与缺页分别会改变哪些状态？',
  },
  {
    id: 'dijkstra', number: '01', title: 'Dijkstra · 单源最短路径', course: '数据结构与算法', difficulty: '基础', tags: ['有向图', 'Dijkstra', '最短路径'],
    description: '给定一个包含 n 个顶点、m 条边的有向图，顶点编号为 1 到 n，每条边的权值均为正整数。请使用 Dijkstra 算法，求源点 s 到每个顶点的最短距离。图可能不连通，可能存在重边和自环。请先独立完成规划，再指挥 AI 实现。',
    input: '第一行包含三个整数 n、m、s（1 ≤ n ≤ 500，0 ≤ m ≤ 10000，1 ≤ s ≤ n）。接下来 m 行，每行包含三个整数 u、v、w，表示一条从 u 指向 v、权值为 w 的有向边（1 ≤ u, v ≤ n，1 ≤ w ≤ 1000000）。',
    output: '输出一行 n 个整数，第 i 个整数表示源点 s 到顶点 i 的最短距离。无法到达的顶点输出 -1，源点自身的距离为 0。整数之间用一个空格分隔，行末输出换行。不要求输出路径。',
    sampleInput: '6 7 1\n1 2 7\n1 3 2\n3 2 1\n2 4 3\n3 4 8\n4 5 2\n1 2 9',
    sampleOutput: '0 3 2 6 8 -1',
    notes: '',
  },
  ...coreProblems,
];
const numbers = new Map();
export const problems = bank.map(p => {
  const number = (numbers.get(p.course) || 0) + 1;
  numbers.set(p.course, number);
  return { language: 'c', ...p, number: String(number).padStart(2, '0') };
});
