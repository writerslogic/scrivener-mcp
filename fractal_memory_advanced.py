"""
Fractal Narrative Memory — Advanced Features
- Narrative Graph (SQLite) for character/motif/scene relationships
- Meso/Macro indexing for multi-scale retrieval
- Motif clustering with HDBSCAN
- Integration with micro indexer from prototype

Requirements:
pip install sentence-transformers faiss-cpu regex tqdm numpy sqlite3 hdbscan scikit-learn spacy
python -m spacy download en_core_web_sm
"""

import argparse
import os
import re
import sqlite3
import json
from typing import List, Dict, Tuple, Optional, Any
from dataclasses import dataclass, asdict
from collections import defaultdict
import numpy as np
from sentence_transformers import SentenceTransformer
import faiss
from tqdm import tqdm
import hdbscan
from sklearn.feature_extraction.text import TfidfVectorizer
import spacy

# ---------- Config ----------
EMBED_MODEL = "all-MiniLM-L6-v2"
EMBED_DIM = 384
MICRO_INDEX_PATH = "micro_faiss.index"
MESO_INDEX_PATH = "meso_faiss.index"
MACRO_INDEX_PATH = "macro_faiss.index"
GRAPH_DB_PATH = "narrative_graph.db"
META_PREFIX = "metadata"

# Load spaCy for NER and coreference
nlp = spacy.load("en_core_web_sm")

# ---------- Data Classes ----------
@dataclass
class MicroSegment:
    id: str
    chapter: str
    sent_index: int
    beat_index: int
    text: str
    start_char: int
    end_char: int
    embedding_id: Optional[int] = None

@dataclass
class MesoSegment:
    id: str
    chapter: str
    start_char: int
    end_char: int
    text: str
    micro_ids: List[str]
    scene_type: Optional[str] = None
    embedding_id: Optional[int] = None

@dataclass
class MacroSegment:
    id: str
    chapter_or_arc: str
    start_char: int
    end_char: int
    text: str
    meso_ids: List[str]
    arc_type: Optional[str] = None
    embedding_id: Optional[int] = None

@dataclass
class GraphNode:
    node_id: str
    node_type: str  # character, object, motif, setting, event
    canonical_name: str
    attributes: Dict[str, Any]
    frequency: int = 1
    centrality: Optional[float] = None

@dataclass
class GraphEdge:
    edge_id: str
    from_node: str
    to_node: str
    edge_type: str  # cooccurrence, interacts, causal, temporal
    weight: float = 1.0
    evidence: Dict[str, Any] = None

# ---------- Meso/Macro Segmentation ----------
class MultiScaleSegmenter:
    """Creates meso (scene) and macro (chapter) segments from text"""
    
    def __init__(self, meso_window=(200, 800), overlap=50):
        self.meso_window = meso_window
        self.overlap = overlap
    
    def detect_scene_breaks(self, text: str) -> List[int]:
        """Find natural scene boundaries in text"""
        breaks = [0]
        
        # Look for explicit scene markers
        patterns = [
            r'\n\n\*\*\*\n\n',     # asterisk breaks
            r'\n\n---\n\n',        # dash breaks
            r'\n\n\s{3,}\n\n',     # multiple blank lines
            r'\n\nChapter \d+',    # chapter markers
            r'\n\n\d+\.\n\n',      # numbered sections
        ]
        
        for pattern in patterns:
            for match in re.finditer(pattern, text):
                breaks.append(match.start())
        
        # Also detect major setting changes using spaCy
        doc = nlp(text[:5000] if len(text) > 5000 else text)  # Sample for speed
        last_location = None
        
        for ent in doc.ents:
            if ent.label_ in ["LOC", "GPE"]:
                if last_location and ent.text != last_location:
                    # Potential scene break at location change
                    breaks.append(ent.start_char)
                last_location = ent.text
        
        return sorted(set(breaks))
    
    def create_meso_segments(self, text: str, chapter: str, micro_segments: List[MicroSegment]) -> List[MesoSegment]:
        """Create meso-level segments (scenes)"""
        scene_breaks = self.detect_scene_breaks(text)
        meso_segments = []
        
        if len(scene_breaks) > 1:
            # Use natural scene boundaries
            for i in range(len(scene_breaks) - 1):
                start = scene_breaks[i]
                end = scene_breaks[i + 1] if i + 1 < len(scene_breaks) else len(text)
                
                # Find micro segments in this range
                micro_ids = [m.id for m in micro_segments 
                           if m.start_char >= start and m.end_char <= end]
                
                if micro_ids:
                    meso_segments.append(MesoSegment(
                        id=f"meso_{chapter}_{i}",
                        chapter=chapter,
                        start_char=start,
                        end_char=end,
                        text=text[start:end],
                        micro_ids=micro_ids,
                        scene_type=self.classify_scene_type(text[start:end])
                    ))
        else:
            # Fall back to sliding windows
            meso_segments = self.create_sliding_windows(text, chapter, micro_segments)
        
        return meso_segments
    
    def create_sliding_windows(self, text: str, chapter: str, micro_segments: List[MicroSegment]) -> List[MesoSegment]:
        """Create meso segments using sliding windows"""
        meso_segments = []
        words = text.split()
        window_size = self.meso_window[1]
        step = window_size - self.overlap
        
        for i, start_idx in enumerate(range(0, len(words), step)):
            end_idx = min(start_idx + window_size, len(words))
            window_text = ' '.join(words[start_idx:end_idx])
            
            # Approximate character positions
            start_char = len(' '.join(words[:start_idx])) if start_idx > 0 else 0
            end_char = len(' '.join(words[:end_idx]))
            
            # Find micro segments in this window
            micro_ids = [m.id for m in micro_segments
                        if m.start_char >= start_char and m.end_char <= end_char]
            
            if micro_ids:
                meso_segments.append(MesoSegment(
                    id=f"meso_{chapter}_w{i}",
                    chapter=chapter,
                    start_char=start_char,
                    end_char=end_char,
                    text=window_text,
                    micro_ids=micro_ids,
                    scene_type=self.classify_scene_type(window_text)
                ))
        
        return meso_segments
    
    def classify_scene_type(self, text: str) -> str:
        """Classify the type of scene"""
        dialogue_ratio = len(re.findall(r'["\'"]', text)) / max(len(text), 1)
        action_words = len(re.findall(r'\b(ran|jumped|fought|grabbed|threw|moved|walked)\b', text, re.I))
        
        if dialogue_ratio > 0.05:
            return "dialogue"
        elif action_words > 5:
            return "action"
        elif len(text) < 500:
            return "transition"
        else:
            return "description"
    
    def create_macro_segment(self, text: str, chapter: str, meso_segments: List[MesoSegment]) -> MacroSegment:
        """Create a macro-level segment for the chapter"""
        return MacroSegment(
            id=f"macro_{chapter}",
            chapter_or_arc=chapter,
            start_char=0,
            end_char=len(text),
            text=text[:2000] + "..." if len(text) > 2000 else text,  # Truncate for storage
            meso_ids=[m.id for m in meso_segments],
            arc_type=self.detect_arc_type(text)
        )
    
    def detect_arc_type(self, text: str) -> str:
        """Detect narrative arc type"""
        # Simple heuristic based on keywords
        if re.search(r'\b(beginning|started|first|introduced)\b', text[:500], re.I):
            return "setup"
        elif re.search(r'\b(climax|peak|confrontation|battle)\b', text, re.I):
            return "climax"
        elif re.search(r'\b(ended|conclusion|finally|resolved)\b', text[-500:], re.I):
            return "resolution"
        else:
            return "rising"

# ---------- Narrative Graph Manager ----------
class NarrativeGraphManager:
    """Manages the narrative graph in SQLite"""
    
    def __init__(self, db_path: str = GRAPH_DB_PATH):
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self.init_schema()
        self.character_aliases = self.load_character_aliases()
    
    def init_schema(self):
        """Initialize database schema"""
        cursor = self.conn.cursor()
        
        # Nodes table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS nodes (
                node_id TEXT PRIMARY KEY,
                node_type TEXT NOT NULL,
                canonical_name TEXT NOT NULL,
                attributes TEXT,
                frequency INTEGER DEFAULT 1,
                centrality REAL
            )
        """)
        
        # Edges table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS edges (
                edge_id TEXT PRIMARY KEY,
                from_node TEXT NOT NULL,
                to_node TEXT NOT NULL,
                edge_type TEXT NOT NULL,
                weight REAL DEFAULT 1.0,
                evidence TEXT,
                FOREIGN KEY (from_node) REFERENCES nodes(node_id),
                FOREIGN KEY (to_node) REFERENCES nodes(node_id)
            )
        """)
        
        # Segment-node mapping
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS segment_nodes (
                segment_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                segment_scale TEXT NOT NULL,
                confidence REAL DEFAULT 1.0,
                PRIMARY KEY (segment_id, node_id),
                FOREIGN KEY (node_id) REFERENCES nodes(node_id)
            )
        """)
        
        # Create indices
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_segment_nodes ON segment_nodes(segment_id)")
        
        self.conn.commit()
    
    def load_character_aliases(self) -> Dict[str, str]:
        """Load character aliases for canonicalization"""
        # In production, load from config file
        return {
            "tom": "Thomas",
            "tommy": "Thomas",
            "robert": "Robert",
            "bob": "Robert",
            "miranda": "Miranda",
            # Add more as needed
        }
    
    def extract_entities(self, text: str, segment_id: str, scale: str = "meso") -> List[GraphNode]:
        """Extract entities from text using NER"""
        doc = nlp(text)
        entities = []
        
        # Extract named entities
        for ent in doc.ents:
            if ent.label_ in ["PERSON", "LOC", "ORG"]:
                node_type = "character" if ent.label_ == "PERSON" else "setting"
                canonical = self.canonicalize(ent.text, node_type)
                
                node = GraphNode(
                    node_id=f"{node_type}_{canonical.lower().replace(' ', '_')}",
                    node_type=node_type,
                    canonical_name=canonical,
                    attributes={"original_text": ent.text, "label": ent.label_}
                )
                entities.append(node)
        
        # Extract motifs (simplified - in production use more sophisticated methods)
        motif_patterns = {
            "frost": r'\b(frost|frozen|ice|icy|cold)\b',
            "purple": r'\b(purple|violet|lavender|mauve)\b',
            "water": r'\b(water|rain|river|stream|ocean|sea)\b',
            "darkness": r'\b(dark|darkness|shadow|night|black)\b',
        }
        
        for motif_name, pattern in motif_patterns.items():
            if re.search(pattern, text, re.I):
                node = GraphNode(
                    node_id=f"motif_{motif_name}",
                    node_type="motif",
                    canonical_name=motif_name,
                    attributes={"pattern": pattern}
                )
                entities.append(node)
        
        return entities
    
    def canonicalize(self, name: str, node_type: str) -> str:
        """Canonicalize entity names"""
        if node_type == "character":
            lower_name = name.lower()
            return self.character_aliases.get(lower_name, name)
        return name
    
    def update_graph(self, segment: Any, scale: str = "meso"):
        """Update graph with entities from a segment"""
        entities = self.extract_entities(segment.text, segment.id, scale)
        cursor = self.conn.cursor()
        
        # Upsert nodes
        node_ids = []
        for entity in entities:
            cursor.execute("""
                INSERT INTO nodes (node_id, node_type, canonical_name, attributes, frequency)
                VALUES (?, ?, ?, ?, 1)
                ON CONFLICT(node_id) DO UPDATE SET
                frequency = frequency + 1
            """, (entity.node_id, entity.node_type, entity.canonical_name, 
                  json.dumps(entity.attributes)))
            
            node_ids.append(entity.node_id)
            
            # Link segment to node
            cursor.execute("""
                INSERT OR IGNORE INTO segment_nodes (segment_id, node_id, segment_scale)
                VALUES (?, ?, ?)
            """, (segment.id, entity.node_id, scale))
        
        # Create co-occurrence edges
        for i in range(len(node_ids)):
            for j in range(i + 1, len(node_ids)):
                edge_id = f"{node_ids[i]}_{node_ids[j]}_cooccur"
                cursor.execute("""
                    INSERT INTO edges (edge_id, from_node, to_node, edge_type, weight, evidence)
                    VALUES (?, ?, ?, 'cooccurrence', 1.0, ?)
                    ON CONFLICT(edge_id) DO UPDATE SET
                    weight = weight + 1.0
                """, (edge_id, node_ids[i], node_ids[j], 
                      json.dumps({"segment": segment.id, "scale": scale})))
        
        self.conn.commit()
        self.update_centrality()
    
    def update_centrality(self):
        """Update node centrality (simple degree centrality)"""
        cursor = self.conn.cursor()
        cursor.execute("""
            UPDATE nodes
            SET centrality = (
                SELECT COUNT(*) FROM edges
                WHERE edges.from_node = nodes.node_id
                OR edges.to_node = nodes.node_id
            )
        """)
        self.conn.commit()
    
    def query_graph(self, node_names: List[str], edge_type: Optional[str] = None) -> List[Dict]:
        """Query graph for nodes and their relationships"""
        cursor = self.conn.cursor()
        
        # Build query for multiple nodes
        placeholders = ','.join('?' * len(node_names))
        base_query = f"""
            SELECT DISTINCT s.segment_id, s.segment_scale, n.canonical_name, n.node_type
            FROM segment_nodes s
            JOIN nodes n ON s.node_id = n.node_id
            WHERE n.canonical_name IN ({placeholders})
        """
        
        results = cursor.execute(base_query, node_names).fetchall()
        
        # Group by segment
        segments = defaultdict(list)
        for row in results:
            segments[row['segment_id']].append({
                'node': row['canonical_name'],
                'type': row['node_type'],
                'scale': row['segment_scale']
            })
        
        # Return segments that contain all requested nodes
        matching_segments = []
        for seg_id, nodes in segments.items():
            node_names_in_seg = [n['node'] for n in nodes]
            if all(name in node_names_in_seg for name in node_names):
                matching_segments.append({
                    'segment_id': seg_id,
                    'nodes': nodes
                })
        
        return matching_segments
    
    def find_continuity_violations(self, character: str) -> List[Dict]:
        """Find potential continuity violations for a character"""
        cursor = self.conn.cursor()
        
        # Find all segments with this character
        results = cursor.execute("""
            SELECT s.segment_id, s.segment_scale, n.attributes
            FROM segment_nodes s
            JOIN nodes n ON s.node_id = n.node_id
            WHERE n.canonical_name = ? AND n.node_type = 'character'
            ORDER BY s.segment_id
        """, (character,)).fetchall()
        
        # Analyze for contradictions (simplified)
        violations = []
        prev_attributes = None
        
        for row in results:
            curr_attributes = json.loads(row['attributes']) if row['attributes'] else {}
            
            if prev_attributes:
                # Check for contradictions (this would be more sophisticated in production)
                if prev_attributes.get('status') == 'dead' and curr_attributes.get('status') == 'alive':
                    violations.append({
                        'type': 'resurrection',
                        'character': character,
                        'segment': row['segment_id'],
                        'details': 'Character appears alive after being dead'
                    })
            
            prev_attributes = curr_attributes
        
        return violations

# ---------- Fractal Retrieval System ----------
class FractalRetriever:
    """Multi-scale retrieval system"""
    
    def __init__(self, embed_model: str = EMBED_MODEL):
        self.model = SentenceTransformer(embed_model)
        self.embed_dim = EMBED_DIM
        self.indices = {}
        self.metadata = {}
        self.graph_manager = NarrativeGraphManager()
    
    def load_or_create_index(self, scale: str) -> faiss.Index:
        """Load or create FAISS index for a scale"""
        index_paths = {
            'micro': MICRO_INDEX_PATH,
            'meso': MESO_INDEX_PATH,
            'macro': MACRO_INDEX_PATH
        }
        
        index_path = index_paths[scale]
        if os.path.exists(index_path):
            return faiss.read_index(index_path)
        else:
            return faiss.IndexFlatIP(self.embed_dim)
    
    def index_segments(self, segments: List[Any], scale: str):
        """Index segments at a given scale"""
        print(f"Indexing {len(segments)} {scale} segments...")
        
        # Get index
        if scale not in self.indices:
            self.indices[scale] = self.load_or_create_index(scale)
        
        index = self.indices[scale]
        
        # Encode texts
        texts = [s.text for s in segments]
        embeddings = self.model.encode(texts, show_progress_bar=True, convert_to_numpy=True)
        faiss.normalize_L2(embeddings)
        
        # Add to index
        start_id = index.ntotal
        index.add(embeddings)
        
        # Store metadata
        if scale not in self.metadata:
            self.metadata[scale] = []
        
        for i, seg in enumerate(segments):
            seg.embedding_id = start_id + i
            self.metadata[scale].append(asdict(seg))
        
        # Save index
        index_paths = {
            'micro': MICRO_INDEX_PATH,
            'meso': MESO_INDEX_PATH,
            'macro': MACRO_INDEX_PATH
        }
        faiss.write_index(index, index_paths[scale])
        
        # Save metadata
        np.save(f"{META_PREFIX}_{scale}.npy", np.array(self.metadata[scale], dtype=object))
        
        # Update graph for meso segments
        if scale == 'meso':
            for seg in segments:
                self.graph_manager.update_graph(seg, scale)
    
    def fractal_retrieve(
        self, 
        query: str, 
        k: int = 10,
        scale_weights: Dict[str, float] = None,
        policy: Optional[str] = None
    ) -> List[Dict]:
        """
        Multi-scale retrieval with graph boosting
        
        Policies:
        - 'line-fix': Focus on micro (0.9 micro, 0.1 meso)
        - 'scene-fix': Focus on meso (0.2 micro, 0.7 meso, 0.1 macro)
        - 'thematic': Focus on macro (0.1 micro, 0.3 meso, 0.6 macro)
        """
        
        # Apply policy
        if policy:
            if policy == 'line-fix':
                scale_weights = {'micro': 0.9, 'meso': 0.1, 'macro': 0.0}
            elif policy == 'scene-fix':
                scale_weights = {'micro': 0.2, 'meso': 0.7, 'macro': 0.1}
            elif policy == 'thematic':
                scale_weights = {'micro': 0.1, 'meso': 0.3, 'macro': 0.6}
        
        if not scale_weights:
            scale_weights = {'micro': 1.0, 'meso': 0.6, 'macro': 0.3}
        
        # Encode query
        q_emb = self.model.encode([query], convert_to_numpy=True)
        faiss.normalize_L2(q_emb)
        
        results = []
        
        for scale, weight in scale_weights.items():
            if weight == 0 or scale not in self.indices:
                continue
            
            index = self.indices[scale]
            meta = self.metadata.get(scale, [])
            
            if index.ntotal == 0:
                continue
            
            # Search
            search_k = min(int(k * weight * 2), index.ntotal)
            D, I = index.search(q_emb, search_k)
            
            for score, idx in zip(D[0], I[0]):
                if idx < 0 or idx >= len(meta):
                    continue
                
                segment = meta[idx]
                
                # Compute graph boost
                graph_boost = self.compute_graph_boost(segment, query)
                
                # Compute context boost (recency, importance, etc.)
                context_boost = 0.0  # Placeholder
                
                # Final score
                final_score = weight * score + 0.2 * graph_boost + 0.1 * context_boost
                
                results.append({
                    'scale': scale,
                    'score': float(final_score),
                    'segment': segment,
                    'graph_boost': graph_boost,
                    'context_boost': context_boost
                })
        
        # Sort by score and return top k
        results.sort(key=lambda x: x['score'], reverse=True)
        return results[:k]
    
    def compute_graph_boost(self, segment: Dict, query: str) -> float:
        """Compute graph-based boost for a segment"""
        # Extract query entities
        doc = nlp(query)
        query_entities = [ent.text for ent in doc.ents if ent.label_ in ["PERSON", "LOC"]]
        
        if not query_entities:
            return 0.0
        
        # Check if segment contains high-centrality nodes matching query
        cursor = self.graph_manager.conn.cursor()
        
        boost = 0.0
        for entity in query_entities:
            canonical = self.graph_manager.canonicalize(entity, "character")
            result = cursor.execute("""
                SELECT n.centrality
                FROM segment_nodes s
                JOIN nodes n ON s.node_id = n.node_id
                WHERE s.segment_id = ? AND n.canonical_name = ?
            """, (segment['id'], canonical)).fetchone()
            
            if result and result[0]:
                boost += min(result[0] / 100.0, 0.5)  # Cap boost at 0.5
        
        return boost

# ---------- Motif Clustering ----------
class MotifClusterer:
    """Discover and cluster narrative motifs"""
    
    def __init__(self, min_cluster_size: int = 5):
        self.min_cluster_size = min_cluster_size
        self.clusterer = hdbscan.HDBSCAN(min_cluster_size=min_cluster_size, metric='euclidean')
        self.vectorizer = TfidfVectorizer(max_features=100, stop_words='english')
    
    def cluster_embeddings(self, embeddings: np.ndarray, texts: List[str]) -> Dict[int, Dict]:
        """Cluster embeddings and extract motifs"""
        print(f"Clustering {len(embeddings)} embeddings...")
        
        # Run clustering
        labels = self.clusterer.fit_predict(embeddings)
        
        # Group by cluster
        clusters = defaultdict(list)
        for i, label in enumerate(labels):
            if label >= 0:  # Ignore noise (-1)
                clusters[label].append(i)
        
        # Extract keywords for each cluster
        motifs = {}
        for cluster_id, indices in clusters.items():
            cluster_texts = [texts[i] for i in indices]
            
            # Extract keywords using TF-IDF
            if len(cluster_texts) >= 2:
                tfidf_matrix = self.vectorizer.fit_transform(cluster_texts)
                feature_names = self.vectorizer.get_feature_names_out()
                
                # Get top keywords
                scores = tfidf_matrix.sum(axis=0).A1
                top_indices = scores.argsort()[-10:][::-1]
                keywords = [feature_names[i] for i in top_indices]
                
                # Generate label
                label = self.generate_motif_label(keywords)
                
                motifs[cluster_id] = {
                    'label': label,
                    'keywords': keywords,
                    'size': len(indices),
                    'segment_indices': indices[:10]  # Sample segments
                }
        
        return motifs
    
    def generate_motif_label(self, keywords: List[str]) -> str:
        """Generate a label for a motif cluster"""
        # Simple heuristic labeling
        keyword_set = set(keywords)
        
        if {'frost', 'cold', 'ice', 'frozen'} & keyword_set:
            return 'cold-presence'
        elif {'purple', 'violet', 'stain'} & keyword_set:
            return 'purple-motif'
        elif {'water', 'rain', 'river', 'ocean'} & keyword_set:
            return 'water-imagery'
        elif {'dark', 'shadow', 'night', 'darkness'} & keyword_set:
            return 'darkness-theme'
        else:
            # Default: join top 3 keywords
            return '-'.join(keywords[:3])

# ---------- Main Fractal Memory System ----------
class FractalNarrativeMemory:
    """Complete fractal narrative memory system"""
    
    def __init__(self):
        self.segmenter = MultiScaleSegmenter()
        self.retriever = FractalRetriever()
        self.graph_manager = NarrativeGraphManager()
        self.motif_clusterer = MotifClusterer()
        self.model = SentenceTransformer(EMBED_MODEL)
    
    def ingest_chapter(self, text: str, chapter_label: str):
        """Ingest a chapter and build all indices"""
        print(f"Ingesting chapter: {chapter_label}")
        
        # Create micro segments (reuse from prototype)
        from fractal_memory_prototype import MicroIndexer
        micro_indexer = MicroIndexer()
        micro_dicts = micro_indexer.build_micro_segments(text, chapter_label)
        micro_segments = [MicroSegment(**m) for m in micro_dicts]
        
        # Create meso segments
        meso_segments = self.segmenter.create_meso_segments(text, chapter_label, micro_segments)
        
        # Create macro segment
        macro_segment = self.segmenter.create_macro_segment(text, chapter_label, meso_segments)
        
        # Index at all scales
        self.retriever.index_segments(micro_segments, 'micro')
        self.retriever.index_segments(meso_segments, 'meso')
        self.retriever.index_segments([macro_segment], 'macro')
        
        print(f"Indexed: {len(micro_segments)} micro, {len(meso_segments)} meso, 1 macro")
        
        # Run motif clustering on meso segments
        if len(meso_segments) >= 5:
            meso_texts = [s.text for s in meso_segments]
            meso_embeddings = self.model.encode(meso_texts, convert_to_numpy=True)
            motifs = self.motif_clusterer.cluster_embeddings(meso_embeddings, meso_texts)
            
            print(f"Discovered {len(motifs)} motif clusters")
            for cluster_id, motif in motifs.items():
                print(f"  Cluster {cluster_id}: {motif['label']} ({motif['size']} segments)")
                print(f"    Keywords: {', '.join(motif['keywords'][:5])}")
    
    def query(
        self, 
        query_text: str, 
        k: int = 10,
        policy: Optional[str] = None
    ) -> List[Dict]:
        """Query the fractal memory"""
        return self.retriever.fractal_retrieve(query_text, k, policy=policy)
    
    def find_character_motif_intersections(self, character: str, motif: str) -> List[Dict]:
        """Find where a character and motif co-occur"""
        return self.graph_manager.query_graph([character, motif])
    
    def check_continuity(self, character: str) -> List[Dict]:
        """Check for continuity violations"""
        return self.graph_manager.find_continuity_violations(character)

# ---------- CLI Interface ----------
def main():
    parser = argparse.ArgumentParser(description="Fractal Narrative Memory System")
    parser.add_argument("--ingest", help="Ingest a text file as a chapter")
    parser.add_argument("--chapter", default="ch1", help="Chapter label for ingestion")
    parser.add_argument("--query", help="Query the memory")
    parser.add_argument("--policy", choices=['line-fix', 'scene-fix', 'thematic'], 
                       help="Retrieval policy")
    parser.add_argument("--find", nargs='+', help="Find intersections (e.g., 'Tom frost courtroom')")
    parser.add_argument("--continuity", help="Check continuity for a character")
    parser.add_argument("--interactive", action="store_true", help="Interactive query mode")
    
    args = parser.parse_args()
    
    memory = FractalNarrativeMemory()
    
    if args.ingest:
        with open(args.ingest, 'r', encoding='utf-8') as f:
            text = f.read()
        memory.ingest_chapter(text, args.chapter)
    
    elif args.query:
        results = memory.query(args.query, policy=args.policy)
        for r in results[:5]:
            print(f"\n[{r['scale']}] Score: {r['score']:.3f}")
            print(f"  ID: {r['segment']['id']}")
            print(f"  Text: {r['segment']['text'][:200]}...")
            if r['graph_boost'] > 0:
                print(f"  Graph boost: {r['graph_boost']:.3f}")
    
    elif args.find:
        # Find intersections of entities/motifs
        results = memory.graph_manager.query_graph(args.find)
        print(f"\nFound {len(results)} segments containing all: {', '.join(args.find)}")
        for r in results[:5]:
            print(f"  Segment: {r['segment_id']}")
            print(f"  Nodes: {[n['node'] for n in r['nodes']]}")
    
    elif args.continuity:
        violations = memory.check_continuity(args.continuity)
        if violations:
            print(f"\nFound {len(violations)} potential continuity issues for {args.continuity}:")
            for v in violations:
                print(f"  {v['type']}: {v['details']} in {v['segment']}")
        else:
            print(f"\nNo continuity issues found for {args.continuity}")
    
    elif args.interactive:
        print("Interactive mode. Commands:")
        print("  query <text> - Search across all scales")
        print("  find <entity1> <entity2> ... - Find intersections")
        print("  continuity <character> - Check continuity")
        print("  exit - Quit")
        
        while True:
            cmd = input("\n> ").strip().split(None, 1)
            if not cmd:
                continue
            
            if cmd[0] == "exit":
                break
            elif cmd[0] == "query" and len(cmd) > 1:
                results = memory.query(cmd[1])
                for r in results[:3]:
                    print(f"[{r['scale']}] {r['score']:.3f}: {r['segment']['text'][:100]}...")
            elif cmd[0] == "find" and len(cmd) > 1:
                entities = cmd[1].split()
                results = memory.graph_manager.query_graph(entities)
                print(f"Found {len(results)} segments with all entities")
            elif cmd[0] == "continuity" and len(cmd) > 1:
                violations = memory.check_continuity(cmd[1])
                print(f"Found {len(violations)} continuity issues")
    
    else:
        parser.print_help()

if __name__ == "__main__":
    main()