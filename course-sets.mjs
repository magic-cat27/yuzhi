import { problems } from './problems.mjs';
import { coreCourses, courseSources } from './core-problems.mjs';

export const problemSets = [
  { id: 'c-programming', title: 'C语言程序设计与实验', category: '基础课程', source: { title: 'PTA C语言教材题集', url: 'https://pintia.cn/problem-sets/1298273728383766528' } },
  ...coreCourses.map(([id, title]) => ({ id, title, category: '专业核心', source: courseSources[id] })),
].map(set => ({ ...set, course: set.title, language: set.id === 'oop' ? 'cpp' : 'c',
  problemIds: problems.filter(p => p.course === set.title).map(p => p.id) }));
