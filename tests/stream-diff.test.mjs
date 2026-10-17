import test from 'node:test';
import assert from 'node:assert/strict';
import {readModelStream} from '../src/model-stream.mjs';
import {diffLines,renderCodeDiff} from '../public/code-diff.js';
const stream=(frames,done=true)=>{
 const bytes=new TextEncoder().encode(frames.map(x=>'data: '+JSON.stringify(x)+'\r\n\r\n').join('')+(done?'data: [DONE]\r\n\r\n':''));
 return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close();}}));
};
test('SSE reconstructs split UTF-8, content, tool JSON and trailing usage',async()=>{
 const deltas=[],usages=[];
 const result=await readModelStream(stream([
  {choices:[{delta:{content:'你好'}}]},
  {choices:[{delta:{content:'，同学',tool_calls:[{index:0,id:'call_1',function:{name:'propose_changes',arguments:'{"changes":'}}]}}]},
  {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'[]}'}}]},finish_reason:'tool_calls'}]},
  {choices:[],usage:{prompt_tokens:10,completion_tokens:8}}
 ]),d=>deltas.push(d),u=>usages.push(u));
 assert.equal(result.choices[0].message.content,'你好，同学');
 assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments),{changes:[]});
 assert.equal(deltas.filter(d=>d.text).length,2);assert.equal(usages[0].completion_tokens,8);
 assert.ok(deltas.every(d=>!('arguments' in d)));
});
test('interrupted SSE fails closed but reports known usage',async()=>{
 let usage;await assert.rejects(readModelStream(stream([{choices:[{delta:{content:'部分'}}]},{choices:[],usage:{prompt_tokens:3,completion_tokens:1}}],false),()=>{},u=>usage=u),/Incomplete stream/);
 assert.equal(usage.completion_tokens,1);
});
test('line diff replays both versions including empty files, duplicate lines and EOF changes',()=>{
 for(const [before,after] of [['a\nb\nc\n','a\nx\nc\n'],['','a\n'],['a',''],['x\nx\ny','x\ny\ny'],['x\n','x'],['a\n'.repeat(1800),'b\n'.repeat(1800)]]){
  const rows=diffLines(before,after);
  assert.equal(rows.filter(r=>r.type!=='add').map(r=>r.text).join(''),before);
  assert.equal(rows.filter(r=>r.type!=='remove').map(r=>r.text).join(''),after);
 }
 const html=renderCodeDiff({path:'<file>',before:'<script>\n',after:'<img onerror=x>\n'});
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.match(html,/diff-remove/);assert.match(html,/diff-add/);
});
