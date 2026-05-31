import type JSZip from "jszip";

export interface OoxmlMeta {
  creator?: string;
  lastModifiedBy?: string;
  company?: string;
  creationDate?: string;
  pageCountHint?: number;
}

export async function parseOoxmlMeta(zip: JSZip): Promise<OoxmlMeta> {
  const meta: OoxmlMeta = {};

  const coreFile = zip.file("docProps/core.xml");
  if (coreFile) {
    const xml = await coreFile.async("string");
    const creator = xml.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/)?.[1]?.trim();
    const lastBy  = xml.match(/<cp:lastModifiedBy[^>]*>([^<]+)<\/cp:lastModifiedBy>/)?.[1]?.trim();
    const created = xml.match(/<dcterms:created[^>]*>([^<]+)<\/dcterms:created>/)?.[1]?.trim();
    if (creator) meta.creator = creator;
    if (lastBy)  meta.lastModifiedBy = lastBy;
    if (created) meta.creationDate = created;
  }

  const appFile = zip.file("docProps/app.xml");
  if (appFile) {
    const xml = await appFile.async("string");
    const company = xml.match(/<Company>([^<]+)<\/Company>/)?.[1]?.trim();
    const pages   = xml.match(/<Pages>(\d+)<\/Pages>/)?.[1];
    if (company) meta.company = company;
    if (pages)   meta.pageCountHint = parseInt(pages, 10);
  }

  return meta;
}
