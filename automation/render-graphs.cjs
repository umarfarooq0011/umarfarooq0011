const THEMES = {
  light: {text:'#1f2328',muted:'#59636e',levels:['#eff2f5','#aceebb','#4ac26b','#2da44e','#116329']},
  dark: {text:'#f0f6fc',muted:'#a1aab5',levels:['#161b22','#0e4429','#006d32','#26a641','#39d353']}
};
const escapeXml = value => String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const dateLabel = value => new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(value+'T00:00:00Z'));
const dateLong = value => new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(value+'T00:00:00Z'));
function text(theme,x,y,value,size=14,fill='text',weight=400,anchor='start'){
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${escapeXml(theme[fill]||fill)}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}
function svg(width,height,title,description,body){
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">${escapeXml(title)}</title><desc id="desc">${escapeXml(description)}</desc><g font-family="Segoe UI,Arial,Helvetica,sans-serif">${body}</g></svg>\n`;
}
function validateDays(days,total,active){
  if(days.length!==365) throw new Error('Calendar must contain exactly 365 days');
  let sum=0, nonzero=0;
  for(let i=0;i<days.length;i++){
    const day=days[i];
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day.date)||!Number.isSafeInteger(day.count)||day.count<0) throw new Error('Invalid calendar entry');
    if(i && Date.parse(day.date)-Date.parse(days[i-1].date)!==86400000) throw new Error('Calendar dates must be contiguous');
    sum+=day.count;
    nonzero+=Number(day.count>0);
  }
  if(sum!==total||nonzero!==active) throw new Error('Calendar totals do not reconcile');
}
function calendar(theme,days,title,scope){
  const offset=new Date(days[0].date+'T00:00:00Z').getUTCDay();
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let previousLabelColumn=-10;
  let body=text(theme,0,22,title,18,'text',600);
  days.forEach(({date,count,level},i)=>{
    const d=new Date(date+'T00:00:00Z'), col=Math.floor((i+offset)/7),row=d.getUTCDay();
    if(!Number.isInteger(level)||level<0||level>4) throw new Error('Invalid calendar intensity');
    body+=`<rect x="${40+col*16}" y="${65+row*16}" width="12" height="12" rx="2" fill="${theme.levels[level]}"><title>${escapeXml(date)}: ${count} ${scope==='GitHub'?'contributions':'commits'}</title></rect>`;
    if((i===0&&d.getUTCDate()<=14)||(d.getUTCDate()===1&&col-previousLabelColumn>=3)){
      body+=text(theme,40+col*16,52,months[d.getUTCMonth()],12,'muted');
      previousLabelColumn=col;
    }
  });
  for(const [row,label] of [[1,'Mon'],[3,'Wed'],[5,'Fri']]) body+=text(theme,0,65+row*16+10,label,11,'muted');
  const range=`${dateLabel(days[0].date)} – ${dateLabel(days.at(-1).date)}`;
  body+=text(theme,0,200,range+(scope==='GitHub'?' · Public profile activity':''),12,'muted');
  body+=text(theme,746,200,'Less',11,'muted');
  theme.levels.forEach((color,i)=>{body+=`<rect x="${775+i*16}" y="189" width="12" height="12" rx="2" fill="${color}"/>`;});
  body+=text(theme,860,200,'More',11,'muted');
  return svg(900,218,title,`${scope} activity. ${range}.`,body);
}
function languages(theme,data,compact=false){
  const rows=data.languages.map(lang=>({...lang,color:lang.color??'#8b949e'}));
  const total=data.languageStatistics.totalBytes;
  if(rows.some(l=>!Number.isSafeInteger(l.bytes)||l.bytes<0)||rows.reduce((s,l)=>s+l.bytes,0)!==total) throw new Error('Invalid language totals');
  const width=compact?480:900,plotWidth=width-16,columns=compact?1:2;
  let body=text(theme,0,22,'Languages across my GitHub repositories',18,'text',600)
    +text(theme,0,47,`${data.repositories.languageRepositoryCount} public repositories · percentage of total code size`,14,'muted');
  let x=0;
  for(const lang of rows){
    if(!/^#[0-9a-f]{6}$/i.test(lang.color)) throw new Error('Invalid language colour');
    const portion=total?lang.bytes/total:0,w=portion*plotWidth;
    body+=`<rect x="${x}" y="67" width="${w}" height="14" fill="${lang.color}"><title>${escapeXml(lang.name)}: ${(portion*100).toFixed(2)}%</title></rect>`;
    x+=w;
  }
  rows.forEach((lang,i)=>{
    const col=i%columns,row=Math.floor(i/columns),x=col*460,y=113+row*39,cw=compact?plotWidth:424;
    const portion=total?lang.bytes/total:0;
    body+=`<circle cx="${x+5}" cy="${y-5}" r="5" fill="${lang.color}"/>`
      +text(theme,x+18,y,lang.name,compact?18:15,'text',500)
      +text(theme,x+cw,y,`${(portion*100).toFixed(2)}%`,compact?18:15,'muted',400,'end')
      +`<rect x="${x+18}" y="${y+8}" width="${cw-18}" height="4" rx="2" fill="${theme.levels[0]}"/>`
      +`<rect x="${x+18}" y="${y+8}" width="${portion*(cw-18)}" height="4" rx="2" fill="${lang.color}"/>`;
  });
  const footer=145+Math.ceil(rows.length/columns)*39;
  body+=text(theme,0,footer,`${compact?'':'GitHub language data · '}Profile repository excluded · Updated ${dateLabel(data.snapshotDate)}`,12,'muted');
  return svg(width,footer+16,'Public repository language distribution','All detected languages across owned public non-fork project repositories, weighted by code size. The profile repository is excluded.',body);
}
function renderGithub(data){
  validateDays(data.calendar.days,data.calendar.totalContributions,data.calendar.activeDays);
  const files={};
  for(const [name,theme] of Object.entries(THEMES)){
    files[`assets/statistics/github-contributions-${name}.svg`]=calendar(theme,data.calendar.days,`${data.calendar.totalContributions} GitHub contributions · ${data.calendar.activeDays} active days`,'GitHub');
    files[`assets/statistics/repository-languages-${name}.svg`]=languages(theme,data);
    files[`assets/statistics/repository-languages-mobile-${name}.svg`]=languages(theme,data,true);
  }
  return files;
}
function renderGitlab(data){
  const days=Object.entries(data.daily_counts).sort(([a],[b])=>a.localeCompare(b)).map(([date,count])=>({date,count,level:count===0?0:count<=3?1:count<=7?2:count<=12?3:4}));
  validateDays(days,data.period_non_merge_commits,data.active_dates_in_period);
  const files={};
  for(const [name,theme] of Object.entries(THEMES)) files[`assets/statistics/automotivedms-contributions-${name}.svg`]=calendar(theme,days,'automotiveDMS · GitLab contributions','GitLab');
  return files;
}
function picture(name,alt,mobile=false){
  return `<picture>\n${mobile?`  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="./assets/statistics/${name}-mobile-dark.svg" />\n  <source media="(max-width: 600px)" srcset="./assets/statistics/${name}-mobile-light.svg" />\n`:''}  <source media="(prefers-color-scheme: dark)" srcset="./assets/statistics/${name}-dark.svg" />\n  <img src="./assets/statistics/${name}-light.svg" width="100%" alt="${escapeXml(alt)}" />\n</picture>`;
}
function replaceMarked(readme,name,replacement){
  const start=`<!-- profile-stats:${name}:start -->`,end=`<!-- profile-stats:${name}:end -->`;
  if(readme.split(start).length!==2||readme.split(end).length!==2||readme.indexOf(end)<readme.indexOf(start)) throw new Error(`Missing or duplicate README markers: ${name}`);
  return readme.slice(0,readme.indexOf(start)+start.length)+'\n'+replacement+'\n'+readme.slice(readme.indexOf(end));
}
function updateReadme(readme,{github,gitlab}){
  if(github){
    readme=replaceMarked(readme,'languages',picture('repository-languages','Percentage breakdown of every detected language across my public GitHub project repositories.',true)+`\n\n<sub>Percentages reflect code size across all my public non-fork repositories, excluding this profile repository. Frameworks such as React and Express are represented through their source languages. Updated ${dateLong(github.snapshotDate)}.</sub>`);
    readme=replaceMarked(readme,'github',`## GitHub activity\n\n${picture('github-contributions','Contribution calendar showing the activity visible on my public GitHub profile.')}\n\n<sub>GitHub activity refreshes automatically and is separate from GitLab activity. Updated ${dateLong(github.snapshotDate)}.</sub>`);
  }
  if(gitlab){
    const dates=Object.keys(gitlab.daily_counts).sort();
    readme=replaceMarked(readme,'gitlab',`**${gitlab.period_non_merge_commits.toLocaleString('en-US')} authored non-merge commits across ${gitlab.active_dates_in_period} active days** during the last 365 days.\n\n${picture('automotivedms-contributions','automotiveDMS authored non-merge contributions on GitLab.')}\n\n<sub>GitLab activity · Author dates on the default branch, ${escapeXml(gitlab.default_branch)} · ${dateLong(dates[0])}–${dateLong(dates.at(-1))} · Refreshed automatically; last update ${dateLong(gitlab.fetched_on)}.</sub>`);
  }
  return readme;
}
module.exports={renderGithub,renderGitlab,updateReadme,replaceMarked,validateDays,escapeXml,dateLabel};
