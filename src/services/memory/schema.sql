-- Fractal Narrative Memory Schema
-- Multi-scale text segmentation with narrative graph

-- Segments table: stores text at different scales
CREATE TABLE IF NOT EXISTS segments (
    id TEXT PRIMARY KEY,
    scale TEXT CHECK(scale IN ('micro', 'meso', 'macro')) NOT NULL,
    chapter_id TEXT NOT NULL,
    text TEXT NOT NULL,
    start_pos INTEGER NOT NULL,
    end_pos INTEGER NOT NULL,
    parent_id TEXT REFERENCES segments(id),
    sequence_num INTEGER NOT NULL,
    embedding BLOB, -- Serialized numpy array
    metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_scale (scale),
    INDEX idx_chapter (chapter_id),
    INDEX idx_parent (parent_id),
    INDEX idx_sequence (chapter_id, scale, sequence_num)
);

-- Entities table: characters, locations, objects
CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    entity_type TEXT CHECK(entity_type IN ('character', 'location', 'object', 'concept')) NOT NULL,
    name TEXT NOT NULL,
    aliases JSON, -- Array of alternative names
    description TEXT,
    first_appearance TEXT REFERENCES segments(id),
    properties JSON,
    embedding BLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_type (entity_type),
    INDEX idx_name (name)
);

-- Entity mentions: track where entities appear
CREATE TABLE IF NOT EXISTS entity_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT REFERENCES entities(id) NOT NULL,
    segment_id TEXT REFERENCES segments(id) NOT NULL,
    mention_text TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    context_before TEXT,
    context_after TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_entity (entity_id),
    INDEX idx_segment (segment_id),
    UNIQUE(entity_id, segment_id, mention_text)
);

-- Motifs table: recurring themes and patterns
CREATE TABLE IF NOT EXISTS motifs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    pattern_type TEXT CHECK(pattern_type IN ('theme', 'symbol', 'phrase', 'structure')) NOT NULL,
    examples JSON, -- Array of example segments
    cluster_id INTEGER, -- From HDBSCAN clustering
    embedding BLOB,
    strength REAL DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cluster (cluster_id),
    INDEX idx_type (pattern_type)
);

-- Motif occurrences: track where motifs appear
CREATE TABLE IF NOT EXISTS motif_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    motif_id TEXT REFERENCES motifs(id) NOT NULL,
    segment_id TEXT REFERENCES segments(id) NOT NULL,
    strength REAL DEFAULT 1.0,
    evidence TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_motif (motif_id),
    INDEX idx_segment (segment_id),
    UNIQUE(motif_id, segment_id)
);

-- Relationships: connections between entities
CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY,
    source_id TEXT REFERENCES entities(id) NOT NULL,
    target_id TEXT REFERENCES entities(id) NOT NULL,
    relationship_type TEXT NOT NULL,
    strength REAL DEFAULT 1.0,
    first_mention TEXT REFERENCES segments(id),
    properties JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_source (source_id),
    INDEX idx_target (target_id),
    INDEX idx_type (relationship_type)
);

-- Scenes: higher-level narrative units
CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL,
    sequence_num INTEGER NOT NULL,
    setting TEXT,
    participants JSON, -- Array of entity IDs
    dominant_motifs JSON, -- Array of motif IDs
    emotional_tone TEXT,
    plot_function TEXT,
    start_segment TEXT REFERENCES segments(id),
    end_segment TEXT REFERENCES segments(id),
    summary TEXT,
    embedding BLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_chapter (chapter_id),
    INDEX idx_sequence (chapter_id, sequence_num)
);

-- Co-occurrences: track which entities/motifs appear together
CREATE TABLE IF NOT EXISTS co_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item1_type TEXT CHECK(item1_type IN ('entity', 'motif')) NOT NULL,
    item1_id TEXT NOT NULL,
    item2_type TEXT CHECK(item2_type IN ('entity', 'motif')) NOT NULL,
    item2_id TEXT NOT NULL,
    segment_id TEXT REFERENCES segments(id) NOT NULL,
    distance INTEGER, -- Token distance between mentions
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_item1 (item1_type, item1_id),
    INDEX idx_item2 (item2_type, item2_id),
    INDEX idx_segment (segment_id)
);

-- Search cache: store frequently accessed queries
CREATE TABLE IF NOT EXISTS search_cache (
    query_hash TEXT PRIMARY KEY,
    query_text TEXT NOT NULL,
    policy TEXT,
    results JSON,
    hit_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_accessed (last_accessed)
);

-- Memory steering: adaptive retrieval policies
CREATE TABLE IF NOT EXISTS memory_policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    scale_weights JSON, -- {"micro": 0.3, "meso": 0.5, "macro": 0.2}
    entity_boost REAL DEFAULT 1.0,
    motif_boost REAL DEFAULT 1.0,
    recency_weight REAL DEFAULT 0.1,
    frequency_weight REAL DEFAULT 0.1,
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default policies
INSERT OR IGNORE INTO memory_policies (id, name, description, scale_weights) VALUES
    ('line-fix', 'Line-level editing', 'Focus on micro segments for precise edits', '{"micro": 0.7, "meso": 0.2, "macro": 0.1}'),
    ('scene-fix', 'Scene-level editing', 'Balance micro and meso for scene work', '{"micro": 0.3, "meso": 0.5, "macro": 0.2}'),
    ('thematic', 'Thematic analysis', 'Focus on macro patterns and motifs', '{"micro": 0.1, "meso": 0.3, "macro": 0.6}'),
    ('continuity', 'Continuity checking', 'Balance all scales for consistency', '{"micro": 0.33, "meso": 0.34, "macro": 0.33}');

-- Analytics: track system performance
CREATE TABLE IF NOT EXISTS retrieval_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    policy TEXT,
    latency_ms INTEGER,
    results_count INTEGER,
    relevance_score REAL,
    user_feedback TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_created (created_at)
);

-- Create view for character continuity
CREATE VIEW IF NOT EXISTS character_continuity AS
SELECT 
    e.name as character_name,
    s.chapter_id,
    s.scale,
    COUNT(DISTINCT em.segment_id) as appearance_count,
    MIN(s.sequence_num) as first_appearance_seq,
    MAX(s.sequence_num) as last_appearance_seq,
    GROUP_CONCAT(DISTINCT s.id) as segment_ids
FROM entities e
JOIN entity_mentions em ON e.id = em.entity_id
JOIN segments s ON em.segment_id = s.id
WHERE e.entity_type = 'character'
GROUP BY e.id, s.chapter_id, s.scale
ORDER BY e.name, s.chapter_id, s.scale;

-- Create view for motif tracking
CREATE VIEW IF NOT EXISTS motif_tracking AS
SELECT 
    m.name as motif_name,
    m.pattern_type,
    s.chapter_id,
    COUNT(DISTINCT mo.segment_id) as occurrence_count,
    AVG(mo.strength) as avg_strength,
    GROUP_CONCAT(s.id) as segment_ids
FROM motifs m
JOIN motif_occurrences mo ON m.id = mo.motif_id
JOIN segments s ON mo.segment_id = s.id
GROUP BY m.id, s.chapter_id
ORDER BY m.name, s.chapter_id;