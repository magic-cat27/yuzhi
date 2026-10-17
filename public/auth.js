const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let session=null;
export const currentSession=()=>session;
export function setSession(value){session=value?.user?value:null;}
export async function authRequest(action,input) {
  const response=await fetch(`/api/auth/${action}`,input===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session?.csrf||''},body:JSON.stringify(input)});
  const result=await response.json();
  if(!response.ok)throw Error(result.error||'请求失败，请重试');
  return result;
}
export function renderAuth(onSuccess) {
  const setup=location.hash.startsWith('#/setup-teacher'), register=location.hash==='#/register';
  const teacher=setup||location.hash.startsWith('#/teacher')||location.hash.includes('role=teacher');
  const token=new URLSearchParams(location.hash.split('?')[1]||'').get('token');
  const creating=setup||register;
  document.body.className='auth-mode';
  document.querySelector('#app').innerHTML=`<main class="auth-page"><section class="auth-intro"><span class="eyebrow">YU ZHI · LEARNING IN PROGRESS</span><h1>让每一步思考，<br>都有迹可循<span>.</span></h1><p>在完整的项目中探索，与 AI 协作，<br>让理解、尝试与修正成为学习的证据。</p><div class="auth-path"><span><b>01</b> 理解问题</span><span><b>02</b> 协作实现</span><span><b>03</b> 回看过程</span></div><div class="auth-illustration" aria-hidden="true"><div><i></i><i></i><i></i><span>PROJECT / main.c</span></div><p><em>int</em> main(<em>void</em>) {</p><p>　<span>// 从你的思路开始</span></p><p>　<em>return</em> 0;</p><p>}</p><label>思考的方向，始终由你掌握。</label></div></section><section class="auth-card"><span class="auth-badge">${teacher?'教学工作台':'学生学习空间'}</span><h2>${setup?'创建教师账号':register?'注册学生账号':'欢迎回来'}</h2><p class="auth-subtitle">${setup?'设置你的专属账号，开始查看学生的学习过程。':register?'创建账号后，即可进入考核项目。':teacher?'使用教师账号登录，查看作答与过程轨迹。':'登录你的账号，继续上一次探索。'}</p><form id="auth-form">${creating?'<label for="auth-name">姓名</label><input id="auth-name" name="name" autocomplete="name" maxlength="40" placeholder="教师可通过姓名识别作答记录" required>':''}<label for="auth-username">用户名</label><input id="auth-username" name="username" autocomplete="username" minlength="3" maxlength="32" pattern="[A-Za-z0-9_]{3,32}" placeholder="3–32 位字母、数字或下划线" required><label for="auth-password">密码</label><input id="auth-password" name="password" type="password" autocomplete="${creating?'new-password':'current-password'}" ${creating?'minlength="12"':''} maxlength="128" placeholder="${creating?'至少 12 个字符，可使用长短语':'输入密码'}" required>${creating?'<label for="auth-confirm">确认密码</label><input id="auth-confirm" name="confirm" type="password" autocomplete="new-password" maxlength="128" placeholder="再次输入密码" required>':''}${register?'<label for="auth-invite">测试邀请码</label><input id="auth-invite" name="inviteCode" autocomplete="off" maxlength="64" placeholder="填写教师提供的邀请码">':''}<p id="auth-error" class="auth-error" role="alert"></p><button class="primary auth-submit" type="submit">${setup?'创建并进入教师端':register?'注册并进入学生端':'登录'} <span>→</span></button></form><div class="auth-bottom">${setup?'此链接仅可使用一次。':register?'已有账号？ <a href="#/login">去登录</a>':'还没有账号？ <a href="#/register">注册学生账号</a>'}</div>${setup?'':`<div class="auth-role-link"><a href="${teacher?'#/login':'#/login?role=teacher'}">${teacher?'← 学生登录':'教师登录 →'}</a></div>`}</section></main>`;
  const form=document.querySelector('#auth-form');
  form.onsubmit=async event=>{
    event.preventDefault();
    const error=document.querySelector('#auth-error'),button=form.querySelector('button');
    const input=Object.fromEntries(new FormData(form));
    error.textContent='';
    if(creating&&input.password!==input.confirm){error.textContent='两次输入的密码不一致';return;}
    delete input.confirm;
    if(setup)input.token=token;
    button.disabled=true;
    try {
      const result=await authRequest(setup?'setup-teacher':register?'register':'login',input);
      setSession(result);form.reset();onSuccess(result);
    }catch(e){if(error.isConnected)error.textContent=e.message;}
    finally{if(button.isConnected)button.disabled=false;}
  };
}
export function renderAccountHeader(onLogout) {
  const user=session?.user;
  document.querySelector('.header-right').innerHTML=user?`<a href="${user.role==='teacher'?'#/teacher':'#/student'}" class="role-switch">${user.role==='teacher'?'教学工作台':'学习空间'}</a>${user.role==='teacher'?'<a href="#/student" class="role-switch">学生视图</a>':''}<span class="account-name">${esc(user.name)}</span><span class="avatar">${user.role==='teacher'?'教师':'学生'}</span><button id="account-logout" class="account-logout">退出登录</button>`:'<span class="header-course">数据结构与算法</span><span class="avatar">驭智</span>';
  document.querySelector('#account-logout')?.addEventListener('click',onLogout);
}
