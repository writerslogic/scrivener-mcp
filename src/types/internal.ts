/**
 * Internal type definitions for Scrivener project handling
 */

export interface ProjectStructure {
    ScrivenerProject?: {
        Binder?: BinderContainer;
        ProjectSettings?: ProjectSettings;
        ProjectTargets?: ProjectTargets;
    };
    _loadTime?: number;
}

export interface ProjectSettings {
    ProjectTitle?: string;
    FullName?: string;
    Author?: string;
}

export interface ProjectTargets {
    DraftTarget?: string;
    SessionTarget?: string;
    Deadline?: string;
}

export interface BinderContainer {
    BinderItem?: BinderItem | BinderItem[];
}

export interface BinderItem {
    UUID?: string;
    ID?: string;
    Type?: string;
    Title?: string;
    MetaData?: BinderMetaData;
    Children?: BinderContainer;
    TextSettings?: unknown;
}

export interface BinderAttributes {
    UUID?: string;
    ID?: string;
    Type?: string;
}

export interface BinderMetaData {
    IncludeInCompile?: string;
    Label?: string;
    Status?: string;
    Synopsis?: string;
    Notes?: string;
    Keywords?: string;
    Created?: string;
    Modified?: string;
    CustomMetaData?: {
        MetaDataItem?: MetaDataItem | MetaDataItem[];
    };
}

export interface MetaDataItem {
    ID?: string;
    id?: string;
    Value?: string;
    _?: string;
}

export interface RTFParserDocument {
    content?: RTFParserContent;
    meta?: {
        title?: string;
        author?: string;
        subject?: string;
        keywords?: string;
        creationDate?: Date;
        modificationDate?: Date;
    };
}

export type RTFParserContent = string | RTFParserContentNode | (string | RTFParserContentNode)[];

export interface RTFParserContentNode {
    value?: string;
    content?: RTFParserContent;
    style?: {
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
        strikethrough?: boolean;
        fontSize?: number;
        [key: string]: unknown;
    };
}

// Error type guard
export interface ErrorWithCode extends Error {
    code?: string;
}

export function isErrorWithCode(error: unknown): error is ErrorWithCode {
    return error instanceof Error && 'code' in error;
}
