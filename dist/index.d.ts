import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "ad-happy";
export declare const inject: string[];
export interface Config {
    pythonCommand: string;
    kicadHappyScripts: string;
    adMcpServer: string;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;
