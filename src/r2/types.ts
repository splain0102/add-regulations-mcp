export const ROOT='r2-index/active.json', STATUS='r2-index/status.json';
export type ObjectRef={key:string;sha256:string;bytes:number;bloom?:string};
export type R2Head={format:1;catalog:ObjectRef;published_at:string;build_version:string;previous?:ObjectRef;count:number};
export type SearchRecord={id:number;kind:'body'|'table';ordinal:number;label:string;n?:string;match?:{cells:string[];row:string;aliases:string[];paths:string[]};analysis_type?:string;group?:string;scope?:'common'|'individual';evidence:ObjectRef;evidence_index:number};
export type R2Document=Record<string,any>&{document_id:string;regulation_id:string;title:string;title_normalized:string;search:ObjectRef[]};
export type R2Catalog={format:1;search_format?:number;build_version:string;parser_version:string;verified_at:string;documents:R2Document[];body_shards:ObjectRef[];table_shards:ObjectRef[];repealed_body_shards?:ObjectRef[];repealed_table_shards?:ObjectRef[];objects:ObjectRef[]};
export type Bucket={get:(key:string)=>Promise<{size?:number;etag?:string;arrayBuffer:()=>Promise<ArrayBuffer>}|null>};
export type Input={name?:string;query?:string;limit?:number;offset?:number;scope?:'body'|'table'|'pdf'|'all';compact?:boolean;include_history?:boolean;includeRegion?:boolean;include_text_box?:boolean;reg_id?:string;include_repealed?:boolean;group_by?:'task';format?:'results'|'full';delegation_scope?:'common'|'individual'};
