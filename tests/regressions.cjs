const assert = require('assert/strict'), fs = require('fs'), vm = require('vm'), path = require('path');
const { execFileSync } = require('child_process');
const ts = require('typescript'), esbuild = require('esbuild');
const tmp = fs.mkdtempSync('/tmp/freeplane-tests-');
function moduleFrom(file) { const out = path.join(tmp, path.basename(file)+'.cjs'); esbuild.buildSync({entryPoints:[file],bundle:true,platform:'node',format:'cjs',outfile:out}); return require(out); }
function parseBody(xml) {
 const script = `import sys,json,xml.etree.ElementTree as E\ndef f(e):\n c=[]\n if e.text:c.append({'nodeType':3,'nodeValue':e.text})\n for x in e:\n  c.append(f(x))\n  if x.tail:c.append({'nodeType':3,'nodeValue':x.tail})\n return {'nodeType':1,'nodeName':e.tag,'tagName':e.tag,'attrs':e.attrib,'childNodes':c,'textContent':''.join(e.itertext())}\nprint(json.dumps(f(E.fromstring(sys.stdin.read()).find('body'))))`;
 const root = JSON.parse(execFileSync('python3',['-c',script],{input:xml.replace(/&nbsp;/g,'&#160;'),encoding:'utf8'}));
 function bind(n,parent) { n.parentElement=parent;n.children=(n.childNodes||[]).filter(x=>x.nodeType===1);for(const c of n.childNodes||[])bind(c,n);n.getAttribute=k=>n.attrs?.[k]||null;n.querySelectorAll=t=>n.children.flatMap(c=>[...(c.tagName===t?[c]:[]),...c.querySelectorAll(t)]);n.querySelector=t=>n.querySelectorAll(t)[0]||null;return n; } return bind(root,null);
}
const rich = moduleFrom('src/mm/richMarkdown.ts');
const sample='<html>\n  <body>\n    <p>\n      <b>## Глава 2.</b>&nbsp;Теоретические основы\n    </p>\n    <p>\n      \n    </p>\n    <p>\n      - Вычислительная сложность адекватна\n    </p>\n  </body></html>';
assert.equal(rich.htmlMarkdown(parseBody(sample)), '**## Глава 2.**\u00a0Теоретические основы\n\n- Вычислительная сложность адекватна');
const code='```python\n  x = 2\n\n  print(x)\n```';assert.equal(rich.htmlMarkdown(parseBody(rich.markdownHtml(code))),code);
const html=rich.markdownHtml('Read [manual](https://example.org/a(b)?x=1&y=2) and [local](<docs/my file.pdf>)');
assert(html.includes('<a href="https://example.org/a(b)?x=1&amp;y=2">manual</a>'));
const md=rich.htmlMarkdown(parseBody(html));assert(md.includes('[local](<docs/my file.pdf>)'));assert.equal(rich.htmlMarkdown(parseBody(rich.markdownHtml(md))),md);
assert(!rich.markdownHtml('`[literal](url)`').includes('<a '));
const xml=moduleFrom('src/mm/xml.ts');const node={children:[],attrs:{},getAttribute(k){return this.attrs[k]||null},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]}};
xml.setText(node,'[label](https://example.org)');assert.equal(node.attrs.LINK,'https://example.org');assert.equal(node.attrs.TEXT,'label');assert.equal(xml.nodeTextSource(node),'[label](<https://example.org>)');xml.setText(node,'plain');assert(!node.attrs.LINK);xml.setText(node,'[target](#fp-node:ID_123)');assert.equal(node.attrs.LINK,'#ID_123');
const {toggleEmphasis}=moduleFrom('src/editorFormatting.ts');
const input={value:'слово рядом',selectionStart:2,selectionEnd:2,setRangeText(s,a,b){this.value=this.value.slice(0,a)+s+this.value.slice(b)},setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b},dispatchEvent(){}};
toggleEmphasis(input,'**');assert.equal(input.value,'**слово** рядом');toggleEmphasis(input,'**');assert.equal(input.value,'слово рядом');
const src=fs.readFileSync('src/FreeplaneView.ts','utf8'), ast=ts.createSourceFile('v.ts',src,ts.ScriptTarget.Latest,true);
const names=['updateAreaSelection','toggleRichPreview'];const methods=ast.statements.find(ts.isClassDeclaration).members.filter(m=>names.includes(m.name?.getText(ast))).map(m=>m.getText(ast)).join('\n');
const context={result:null,serializeDoc:()=>'',nodeById:(doc,id)=>doc[id]};vm.runInNewContext(ts.transpile('class V{'+methods+'}\nresult=new V();'),context);const v=context.result;
v.svg={querySelectorAll:()=>[]};v.layout={nodes:[{id:'a',x:10,y:10,width:20,height:20},{id:'b',x:50,y:10,width:20,height:20}]};v.areaSelecting={base:new Set(['base']),start:{x:0,y:0},current:{x:40,y:40},moved:true};v.updateAreaSelection();assert(v.selectedIds.has('a'));assert(!v.selectedIds.has('b'));v.areaSelecting.current.x=80;v.updateAreaSelection();assert(v.selectedIds.has('b'));v.areaSelecting.current.x=5;v.updateAreaSelection();assert(!v.selectedIds.has('a'));assert(v.selectedIds.has('base'));
function rc(){return {nodeName:'richcontent',attrs:{TYPE:'DETAILS'},getAttribute(k){return this.attrs[k]},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]}}}
const ra=rc(),rb=rc();v.doc={a:{children:[ra]},b:{children:[rb]}};v.selectedIds=new Set(['a','b']);v.richExpanded=new Set(['a']);v.syncRichExpanded=()=>{};v.commit=()=>{};v.toggleRichPreview('b');assert.equal(ra.attrs.HIDDEN,'true');assert.equal(rb.attrs.HIDDEN,'true');v.richExpanded.clear();v.toggleRichPreview('b');assert(!ra.attrs.HIDDEN&&!rb.attrs.HIDDEN);
assert(src.includes('e.code === "KeyB"'));assert(src.includes('e.code === "KeyI"'));
console.log('Passed: Freeplane whitespace, code whitespace, hyperlinks, node LINK storage, word formatting, live selection and group details.');

const { searchPattern } = moduleFrom('src/searchReplace.ts');
const opts={regex:false,caseSensitive:false,wholeWord:false};
assert(searchPattern('a.b',opts).test('A.B'));
assert(!searchPattern('a.b',opts).test('axb'));
assert(!searchPattern('Word',{...opts,caseSensitive:true}).test('word'));
const word=searchPattern('кот',{...opts,wholeWord:true});
assert(word.test('Это КОТ!'));assert(!word.test('коты'));assert(!word.test('кот_1'));
assert.equal('foo foo'.replace(searchPattern('foo',opts,true),()=>'$1'),'$1 $1');
assert.equal('a1 b2'.replace(searchPattern('([a-z])(\\d)',{...opts,regex:true},true),'$2$1'),'1a 2b');
assert.throws(()=>searchPattern('[',{...opts,regex:true}));
const {wikiLabel}=moduleFrom('src/mm/md.ts');
assert.equal(wikiLabel('folder/Name.pdf#page=2'),'Name, p.2');
assert.equal(wikiLabel('Name.docx#page=15'),'Name, p.15');
assert.equal(wikiLabel('Name.pdf#page=2|Custom'),'Custom');
const suggest=ast.statements.find(s=>ts.isClassDeclaration(s)&&s.name.text==='LinkSuggest');
const sm=suggest.members.filter(m=>['accept','handleKey'].includes(m.name?.getText(ast))).map(m=>m.getText(ast)).join('\n');
const sc={result:null,Event};vm.runInNewContext(ts.transpile('class S{'+sm+'}\nresult=new S();'),sc);
const sug=sc.result;sug.label=f=>f.name;sug.close=()=>{sug.open=false};
for(const page of [false,true])for(const embed of [false,true]) {
 const prefix=embed?'![[':'[[';
 const inp={value:prefix+'Na]] tail',selectionStart:prefix.length+2,setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b},focus(){},dispatchEvent(){}};
 Object.assign(sug,{input:inp,embed,matchStart:0,open:true,index:0,items:[{name:'Name.pdf'}]});
 sug.handleKey({key:'Tab',shiftKey:page,preventDefault(){},stopImmediatePropagation(){}});
 const link=prefix+'Name.pdf'+(page?'#page=':'')+']]';
 assert.equal(inp.value,link+' tail');assert.equal(inp.selectionStart,link.length-(page?2:0));
}
const hk=moduleFrom('src/hotkeys.ts');
hk.setHotkeys({'freeplane:promote':[{modifiers:['Mod'],key:'h'}]});
assert.equal(hk.matchAction({ctrlKey:true,metaKey:false,altKey:false,shiftKey:false,code:'KeyH',key:'р'}),'freeplane:promote');
console.log('Passed: search modes, Unicode whole words, regex capture replacements, page labels, Tab/Shift+Tab caret, Ctrl+H conflict.');


const rm=ast.statements.find(ts.isClassDeclaration).members.find(m=>m.name?.getText(ast)==='replaceMatches').getText(ast);
function bindDoc(data){return {data,querySelectorAll:()=>data.map(n=>({...n,children:[]}))};}
const rcx={result:null,searchPattern,serializeDoc:d=>JSON.stringify(d.data),parseMm:s=>bindDoc(JSON.parse(s)),nodeById:(d,id)=>d.data.find(n=>n.id===id),nodeTextSource:n=>n.text,richContentSource:()=>'',setText:(n,s)=>{n.text=s},setRichContent(){throw Error('unexpected')}};
// Keep references shared between querySelectorAll and the serialized document.
rcx.parseMm=s=>{const d=bindDoc(JSON.parse(s));d.querySelectorAll=()=>d.data;return d};
vm.runInNewContext(ts.transpile('class R{'+rm+'}\nresult=new R();'),rcx);
const rv=rcx.result;Object.assign(rv,{doc:bindDoc([{id:'a',text:'cat cat'},{id:'b',text:'cat'}]),selectedId:'a',searchInput:{value:'cat'},replaceInput:{value:'dog'},searchOptions:opts,syncRichExpanded(){},commit(){this.commits=(this.commits||0)+1},searchNode(){},searchCount:{textContent:''}});
rv.replaceMatches(false);assert.equal(rv.doc.data[0].text,'dog cat');assert.equal(rv.doc.data[1].text,'cat');assert.equal(rv.commits,1);
rv.replaceMatches(true);assert.equal(rv.doc.data[0].text,'dog dog');assert.equal(rv.doc.data[1].text,'dog');assert.equal(rv.commits,2);
rv.searchOptions={...opts,regex:true};rv.searchInput.value='[';rv.replaceMatches(true);assert.equal(rv.commits,2);assert.equal(rv.searchCount.textContent,'Invalid regex');
console.log('Passed: single replacement, map-wide replacement, one commit per operation, invalid-regex rollback.');


const {insertMath}=moduleFrom('src/editorFormatting.ts');
input.value='ab';input.selectionStart=input.selectionEnd=1;
insertMath(input);assert.equal(input.value,'a$$b');assert.equal(input.selectionStart,2);
insertMath(input);assert.equal(input.value,'a$$$$b');assert.equal(input.selectionStart,3);
input.value='x+y';input.selectionStart=0;input.selectionEnd=3;
insertMath(input);assert.equal(input.value,'$x+y$');insertMath(input);assert.equal(input.value,'$$x+y$$');
const previous={'freeplane:replace':[{modifiers:['Mod'],key:'h'}],'freeplane:promote':[{modifiers:['Mod'],key:'ArrowLeft'}]};
assert(hk.migrateHotkeys(previous));hk.setHotkeys(previous);
assert.equal(hk.matchAction({ctrlKey:false,metaKey:false,altKey:false,shiftKey:true,code:'KeyF',key:'F'}),'freeplane:replace');
assert.equal(hk.matchAction({ctrlKey:true,metaKey:false,altKey:false,shiftKey:false,code:'Digit4',key:'4'}),'freeplane:insert-math');
assert(!hk.migrateHotkeys({'freeplane:replace':[]}));
assert(!fs.readFileSync('src/main.ts','utf8').includes('cleanupRecovery'));
const recoveryMethod=ast.statements.find(ts.isClassDeclaration).members.find(m=>m.name?.getText(ast)==='checkRecovery').getText(ast);
const recoverContext={result:null,hashText:s=>s,recoveryKey:s=>s,readEnvelope:async()=>({xml:'unsaved',baseHash:'disk',undo:['old'],redo:[]}),readCache:async()=>({}),askRecovery:async()=> 'resume',deleteRecovery:async()=>{throw Error('must not delete')},console};
vm.runInNewContext(ts.transpile('class R{'+recoveryMethod+'}\nresult=new R();'),recoverContext);
const recoveryView=recoverContext.result;recoveryView.plugin={manifest:{dir:'plugin'}};recoveryView.app={vault:{adapter:{}}};
(async()=>{
 for(const disk of ['disk','externally changed']) {
  const result=await recoveryView.checkRecovery({path:'map.mm',name:'map.mm'},disk);
  assert.equal(result.xml,'unsaved');assert.equal(result.dirty,true);assert.equal(result.mmText,disk);
 }
 console.log('Passed: math insertion, hotkey migration, startup preservation and conflict resume.');
})().catch(e=>{console.error(e);process.exitCode=1});

const config=moduleFrom('src/settings.ts');
for(const name of ['Maps search','Индекс карт']) assert(config.validIndexFolder(name));
for(const name of ['', '../notes', '.obsidian', 'a/b', 'CON', 'bad:folder']) assert(!config.validIndexFolder(name));
config.applySettings({searchIndexFolder:'Индекс карт',nodeMaxWidthSymbols:65});
assert.equal(config.settings.searchIndexFolder,'Индекс карт');assert.equal(config.settings.nodeMaxWidthSymbols,65);
config.applySettings({searchIndexFolder:'../bad'});assert.equal(config.settings.searchIndexFolder,'Freeplane search index');
fs.rmSync(tmp,{recursive:true});
