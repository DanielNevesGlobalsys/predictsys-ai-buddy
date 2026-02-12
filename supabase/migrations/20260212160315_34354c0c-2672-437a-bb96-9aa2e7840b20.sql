-- Fix search_path for rpc_upsert_model_selection
alter function public.rpc_upsert_model_selection(uuid,uuid,uuid,text,text,text[],text[]) set search_path = public;