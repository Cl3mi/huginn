# Document Intelligence Scan — Narrative Report

**Scan ID:** scan-1773666225003-f83f68e3
**Generated:** 2026-03-16T13:04:07.397Z
**Model:** llama3.2:3b

> This report provides interpretive context for the metrics in scan-report-2026-03-16T13-03-45.json.
> All interpretations are model-generated. No document content was passed to the LLM.

---

## 1. Corpus Overview

This corpus represents a collection of documents that have been analyzed by our document intelligence scan tool. The fact that 14 out of 14 files were successfully parsed suggests that the tool performed well on this dataset, with only a small percentage of files requiring additional processing to be fully understood.

Looking at the language distribution, we see that English is the dominant language, making up about 80% of the corpus. German and another unknown language also appear in significant numbers, but are less prevalent. This mix of languages has implications for RAG pipeline design, as it suggests that our tool may need to handle a diverse range of linguistic inputs. For example, we may need to consider how to balance the importance of English versus other languages when building our knowledge graph.

The document type mix is also interesting, with three main categories emerging: "other", "abweichliste", and "lastenheft". These categories suggest that there are some documents that don't fit neatly into a specific category, while others appear to be related to specific topics or industries. The fact that only 2 out of the 14 files fall under the "other" category implies that our tool was able to identify and categorize most of the documents with relative accuracy. However, the presence of these categories does suggest that we may need to consider how to handle edge cases or unusual document types in our RAG pipeline design.

---

## 2. Version Pair Signal Decomposition

The signals that drove each version pair's confidence level are as follows: filename similarity and structural match are key contributors to HIGH confidence pairs, indicating that the documents have similar content or structure. For example, a high filename similarity score suggests that the filenames share common tokens, such as "v1" or "v2", which implies that the documents may be related in terms of their purpose or scope. Structural match further reinforces this idea, suggesting that the document's organization and layout are also similar.

In contrast, MEDIUM confidence pairs rely more heavily on semantic cosine similarity, which measures the degree to which two documents have similar meaning. This suggests that the documents may share common concepts or ideas, but not necessarily in terms of their structure or content. The presence of a date delta signal in some pairs indicates that they are related over time, with one document being an update or revision of the other.

The absence of any version pairs (i.e., an empty topPairs list) implies that the corpus may be too small to find meaningful pairs, or that all documents in the corpus are unique and do not share commonalities. If calibration is needed, it suggests that the document intelligence scan's signals may need to be adjusted or refined to better capture relationships between documents. In this case, the absence of version pairs could indicate that the corpus lacks sufficient diversity or context to support meaningful pairings.

---

## 3. Requirement Extraction Quality

The regex-vs-LLM delta of 0.714 indicates that the regular expression is moderately strict compared to the language model's ability to find requirements. A value close to 1 suggests that the LLM finds more requirements than the regex, implying that the regex might be too restrictive and missing some valid requirements. On the other hand, a low value would suggest that the regex has false positives that the LLM rejects, indicating that the regex is too loose.

The document types that appear hardest for requirement extraction are those with high uncertainty counts and deltas by type. This suggests that these documents require more nuanced or context-dependent analysis to accurately extract requirements. The "lastenheft" documents, which have a delta of 0.714, indicate that this document type is moderately challenging for the current extraction method. In contrast, documents like "abweichliste", which have a higher uncertainty count and no delta value provided, may require more advanced analysis or additional training data to improve extraction reliability.

If llmValidationRan is false, it means that the language model was not used to validate the extracted requirements in this run. This leaves some unknowns about the extraction quality, such as whether the regex missed any valid requirements or introduced false positives. The delta value of 0 in this case suggests that the extraction method relies solely on the regular expression and does not have a secondary validation step to confirm its accuracy. As a result, there is no clear indication of how reliable the extracted requirements are, and further evaluation or testing may be necessary to determine their validity.

---

## 4. Chunk Strategy Rationale

When it comes to low-confidence heading_sections documents, a chunking quality assessment reveals that there's some uncertainty around section boundaries. This means that the extracted headings might not accurately represent the actual structure of the document. As a result, retrieval chunks may end up spanning multiple topics or covering sections that don't belong together. This can lead to suboptimal search results and reduced overall effectiveness of the RAG knowledge base.

In terms of dual-strategy candidates, it's clear that these documents have triggered two competing strategies - perhaps one for heading_sections and another for table_rows. This indicates that the document's content is ambiguous or multifaceted, making it challenging to determine the most suitable strategy for chunking. When designing the ingestion pipeline, this raises questions about how to handle such ambiguity. Should we prioritize one strategy over the other, or try to find a way to reconcile the two? The answer will depend on the specific requirements and use cases of our RAG knowledge base.

The overall distribution of strategies across the documents has significant implications for downstream vector store indexing. If certain strategies dominate others, it may indicate that those strategies are more effective at capturing the document's content or structure. Conversely, if multiple strategies are triggered equally often, it could suggest that the document's content is too complex or nuanced to be captured by a single strategy. This information can inform our approach to vector store indexing, helping us optimize our models and improve overall search performance.

---

## 5. Parser Reliability

The parser divergence between OfficeParser and Tika suggests that there's an issue with either the content or structure of the documents being processed. If it's a data quality problem, it means that some documents are missing crucial information like text within tables or have encoding errors that prevent the parser from accurately extracting the content. On the other hand, if it's a structural difference, it could be related to how each parser handles metadata or table extraction.

The distinction between parse failures and OCR requirements is important because parse failures indicate that the file couldn't be read at all, whereas OCR requirements mean that the file was parsed but contains scanned images instead of text. This distinction affects how we handle these files in our ingestion pipeline. If a file can't be parsed due to errors or missing information, it's likely not suitable for RAG ingestion without further processing. However, if a file is parsed but contains scanned images, it may still be worth ingesting into the knowledge base, especially if OCR pre-processing can convert these images into text.

The fact that there are no full OCR counts implies that none of the files were successfully converted to text using OCR. This means that OCR pre-processing is not a blocking dependency before RAG ingestion, as we wouldn't be able to ingest any files without further processing. However, it's still worth noting that some files may require OCR pre-processing to become suitable for ingestion into the knowledge base. The partial OCR count suggests that there are files that were partially converted to text using OCR, but this doesn't necessarily mean they're ready for RAG ingestion yet.

---

## 6. Reference Graph Interpretation

When it comes to document intelligence scans, there are two types of references that can be classified as either likely_missing_from_corpus or likely_matcher_failure. The former refers to documents that were referenced by the system but couldn't find them in its database – essentially, they were mentioned but not present. This could be due to various reasons such as outdated information, incorrect formatting, or simply because the document wasn't included in the corpus at the time of scanning. On the other hand, likely_matcher_failure references are those that exist within the corpus but weren't matched by the system's matching logic – this might indicate a flaw in the system's ability to recognize and link relevant documents.

The norm reference distribution provides valuable insights into the regulatory landscape of this corpus. The presence of various norms such as ISO, DIN, VDA, and IATF indicates that the corpus is heavily influenced by industry standards and regulations. This suggests that the RAG system will need to be able to handle a diverse range of regulatory requirements, which can impact its overall performance and effectiveness. For instance, if the system struggles to match documents with specific norms, it may lead to inaccurate or incomplete information being presented.

The internal reference resolution rate is an important metric for cross-document traceability in a RAG system. It essentially measures how well the system can link related documents together based on their internal references. A high resolution rate indicates that the system is able to effectively connect relevant documents, making it easier to understand the relationships between them and providing a more comprehensive view of the regulatory landscape. Conversely, a low resolution rate may indicate issues with document linking, which could impact the overall accuracy and usefulness of the RAG system.

---

## 7. RAG Readiness Synthesis

Based on the provided cross-cutting summary, our top priority is to address the 14 failed check interpretations that indicate issues with the document's metadata quality and content accuracy. These failed checks suggest that there are discrepancies between the expected and actual content of the documents, which could lead to inaccurate or incomplete information being ingested into the RAG system.

The primary reason for prioritizing these checks is that they directly impact the reliability and trustworthiness of the data. If left unaddressed, these issues can compromise the overall quality of the knowledge base, leading to potential errors or inaccuracies in decision-making processes. By addressing these failed checks, we can ensure that the documents are properly validated and cleaned before being ingested into the system.

Secondary concerns that should be addressed after prioritizing the failed check interpretations include reviewing the low confidence chunk count (2) and the high version pair count (9). These signals suggest that there may be some inconsistencies or ambiguities in the document's content, which could require further investigation to ensure accuracy. Additionally, it would be beneficial to review the language mix rate (0.8571428571428571), as a higher rate indicates potential issues with language translation or detection. However, these concerns are secondary to addressing the failed check interpretations, and should be addressed once the primary issue is resolved.

Actionable guidance:

* Immediately address the 14 failed check interpretations that indicate issues with document metadata quality and content accuracy.
* Review the low confidence chunk count (2) and high version pair count (9) to identify potential inconsistencies or ambiguities in the document's content.
* Investigate the language mix rate to ensure accurate translation and detection.

By following this prioritized approach, we can ensure that the documents are properly validated and cleaned before being ingested into the RAG system, maintaining the overall quality and reliability of the knowledge base.

---

*Generated by Huginn using llama3.2:3b. Validate interpretations before architecture decisions.*