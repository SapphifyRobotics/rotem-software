import { describe,it,expect,vi } from 'vitest';
import { Commands } from '../src/commands';
describe('command acknowledgement',()=>{
 it('ignores streaming data and resolves only matching reply',async()=>{const send=vi.fn(async()=>{});const c=new Commands(send);const p=c.request('GET',s=>s.startsWith('CFG '));c.accept('S t=1');c.accept('CFG saved=0');expect(await p).toBe('CFG saved=0');expect(send).toHaveBeenCalledWith('GET')});
 it('surfaces errors instead of claiming a save',async()=>{const c=new Commands(async()=>{});const p=c.request('SAVE',()=>false);c.accept('ERR flash write');await expect(p).rejects.toThrow('flash write')});
 it('cancels on disconnect and can be reused',async()=>{const c=new Commands(async()=>{});const p=c.request('SAVE',()=>true);c.cancel();await expect(p).rejects.toThrow('disconnected');const q=c.request('GET',()=>true);c.accept('CFG');expect(await q).toBe('CFG')});
 it('times out and releases the command slot',async()=>{vi.useFakeTimers();const c=new Commands(async()=>{});const p=c.request('GET',()=>true,20);const result=expect(p).rejects.toThrow('acknowledgement');await vi.advanceTimersByTimeAsync(21);await result;vi.useRealTimers()});
});
