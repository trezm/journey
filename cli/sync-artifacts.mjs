#!/usr/bin/env node
// Bridges accepted Git history to Cloudflare Artifacts. Credentials stay in process environment.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const {AVC_URL,AVC_PROJECT,AVC_TOKEN,ARTIFACTS_REMOTE,ARTIFACTS_TOKEN,AVC_SITE_SERVICE_TOKEN}=process.env;
if(!AVC_URL||!AVC_PROJECT||!AVC_TOKEN||!ARTIFACTS_REMOTE||!ARTIFACTS_TOKEN)throw new Error('Set AVC_URL, AVC_PROJECT, AVC_TOKEN, ARTIFACTS_REMOTE and ARTIFACTS_TOKEN.');
const remote=new URL(ARTIFACTS_REMOTE);if(remote.protocol!=='https:'||remote.hostname!=='artifacts.cloudflare.net'||remote.username||remote.password)throw new Error('Use the credential-free HTTPS remote returned by Cloudflare Artifacts.');
const temp=await mkdtemp(join(tmpdir(),'journey-artifacts-'));
function authEnv(headers){const e={...process.env,GIT_CONFIG_COUNT:String(headers.length),GIT_TERMINAL_PROMPT:'0'};headers.forEach((h,i)=>{e[`GIT_CONFIG_KEY_${i}`]='http.extraHeader';e[`GIT_CONFIG_VALUE_${i}`]=h;});return e;}
try{const source=AVC_URL.replace(/\/$/,'')+'/api/git/'+AVC_PROJECT+'/';execFileSync('git',['clone','--bare','--quiet',source,temp+'/repo'],{env:authEnv([`Authorization: Bearer ${AVC_TOKEN}`,...(AVC_SITE_SERVICE_TOKEN?[`OAI-Sites-Authorization: Bearer ${AVC_SITE_SERVICE_TOKEN}`]:[])]),stdio:['ignore','pipe','pipe']});execFileSync('git',['-C',temp+'/repo','push','--quiet',remote.toString(),'refs/heads/main:refs/heads/main'],{env:authEnv(['Authorization: Basic '+Buffer.from('x:'+ARTIFACTS_TOKEN.split('?expires=')[0]).toString('base64')]),stdio:['ignore','pipe','pipe']});console.log('Accepted journey history synchronized to Cloudflare Artifacts.');}catch(e){process.stderr.write('Git synchronization failed. Check remote access and history compatibility.\n');process.exitCode=1;}finally{await rm(temp,{recursive:true,force:true});}
