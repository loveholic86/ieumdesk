import { Fragment, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { openProjectChannel, type ProjectChannel } from './project-channel';
import { useAuth } from './auth';
import { validWorkspaceSettings, type WorkspaceSettings, type WorkspaceSettingsPatch } from './workspace-types';

type SettingsContext = {
  settings: WorkspaceSettings | null; loading: boolean; refreshing: boolean; error: string;
  refresh: () => Promise<void>; save: (patch: WorkspaceSettingsPatch) => Promise<WorkspaceSettings>;
};
const Context = createContext<SettingsContext | null>(null);
export function useWorkspaceSettings() {
  const value = useContext(Context);
  if (!value) throw new Error('WORKSPACE_SETTINGS_PROVIDER_REQUIRED');
  return value;
}
export function WorkspaceSettingsProvider({children}:{children:ReactNode}) {
  const {user} = useAuth();
  const [settings,setSettings] = useState<WorkspaceSettings|null>(null);
  const [loading,setLoading] = useState(true);
  const [refreshing,setRefreshing] = useState(false);
  const [error,setError] = useState('');
  const generation = useRef(0);
  const channel = useRef<ProjectChannel|null>(null);
  const alive = useRef(false);
  const saving = useRef(false);
  const current = useRef<WorkspaceSettings|null>(null);
  current.current = settings;
  const accept = useCallback((value:WorkspaceSettings) => {
    if (!validWorkspaceSettings(value)) throw new Error('환경설정 응답을 확인하지 못했습니다.');
    if (!current.current || value.revision >= current.current.revision) {
      current.current = value; setSettings(value);
    }
    setError('');
  },[]);
  const fetchSettings = useCallback(async(quiet=false)=>{
    if(quiet&&saving.current)return;
    const requestGeneration = ++generation.current;
    if(!quiet)setRefreshing(true);
    try {
      const data = await api<WorkspaceSettings>('/settings');
      if (alive.current && generation.current === requestGeneration) accept(data);
    } catch(reason) {
      if (alive.current && generation.current === requestGeneration) {
        // A stale disclosure policy must not keep protected values visible.
        setSettings(null); current.current=null;
        setError(reason instanceof Error ? reason.message : '환경설정을 불러오지 못했습니다.');
      }
      throw reason;
    } finally {
      if (alive.current && generation.current === requestGeneration) {setLoading(false);setRefreshing(false);}
    }
  },[accept]);
  const refresh = useCallback(()=>fetchSettings(false),[fetchSettings]);
  const save = useCallback(async(patch:WorkspaceSettingsPatch)=>{
    const requestGeneration=++generation.current;saving.current=true;setRefreshing(true);
    try {
      const data = await api<WorkspaceSettings>('/settings',{method:'PATCH',body:JSON.stringify(patch)});
      if (!alive.current||generation.current!==requestGeneration) throw new Error('현재 계정의 환경설정을 다시 확인해 주세요.');
      accept(data);setLoading(false);
      channel.current?.postMessage({type:'changed'});
      window.dispatchEvent(new Event('crm:settings-changed'));
      return data;
    } finally { saving.current=false;if (alive.current&&generation.current===requestGeneration) setRefreshing(false); }
  },[accept]);
  useEffect(()=>{
    alive.current=true;setSettings(null);current.current=null;setLoading(true);
    if (!user || user.status !== 'active') {setLoading(false);return;}
    void refresh().catch(()=>{});
    const periodic = window.setInterval(()=>{if(document.visibilityState==='visible')void fetchSettings(true).catch(()=>{});},5000);
    const check = ()=>{if(document.visibilityState==='visible')void refresh().catch(()=>{});};
    window.addEventListener('focus',check);document.addEventListener('visibilitychange',check);
    channel.current = openProjectChannel('workspace-settings', () => {void refresh().catch(()=>{});});
    return ()=>{
      alive.current=false;++generation.current;window.clearInterval(periodic);
      window.removeEventListener('focus',check);document.removeEventListener('visibilitychange',check);
      channel.current?.close();channel.current=null;
    };
  },[user?.id,user?.role,user?.status,refresh,fetchSettings]);
  // Drop every cached list, open editor and pending download when disclosure policy changes.
  // Rechecking an unchanged revision keeps the current workspace and drafts intact.
  return <Context.Provider value={{settings,loading,refreshing,error,refresh,save}}>
    <Fragment key={settings ? `${settings.revision}:${settings.protectionEnabled}` : 'pending'}>{children}</Fragment>
  </Context.Provider>;
}
