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
fs.rmSync(tmp,{recursive:true});
