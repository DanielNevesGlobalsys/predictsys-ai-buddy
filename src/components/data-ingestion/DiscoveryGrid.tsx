import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Search, Eye, Download, Database, Table, Layers, BarChart3, Box } from "lucide-react";
import type { DiscoveryObject } from "@/hooks/useExternalDiscovery";

interface DiscoveryGridProps {
  objects: DiscoveryObject[];
  selectedIds: Set<string>;
  isDiscovering: boolean;
  isImporting: boolean;
  onToggleSelection: (id: string) => void;
  onInspect: (id: string) => void;
  onImport: () => void;
  onRediscover: () => void;
}

const TYPE_ICONS: Record<string, typeof Table> = {
  table: Table,
  view: Layers,
  semantic_model: BarChart3,
  file: Box,
};

const CLASSIFICATION_COLORS: Record<string, string> = {
  fact: "bg-blue-500/10 text-blue-600 border-blue-200",
  dimension: "bg-emerald-500/10 text-emerald-600 border-emerald-200",
  bridge: "bg-amber-500/10 text-amber-600 border-amber-200",
  unknown: "bg-muted text-muted-foreground border-border",
};

const DiscoveryGrid = ({
  objects,
  selectedIds,
  isDiscovering,
  isImporting,
  onToggleSelection,
  onInspect,
  onImport,
  onRediscover,
}: DiscoveryGridProps) => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const filteredObjects = useMemo(() => {
    return objects.filter(obj => {
      const matchesSearch = !searchQuery ||
        obj.object_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (obj.object_schema || '').toLowerCase().includes(searchQuery.toLowerCase());
      const matchesType = !typeFilter || obj.object_type === typeFilter;
      return matchesSearch && matchesType;
    });
  }, [objects, searchQuery, typeFilter]);

  const types = useMemo(() => {
    const set = new Set(objects.map(o => o.object_type));
    return Array.from(set);
  }, [objects]);

  const selectAll = () => {
    filteredObjects.forEach(o => {
      if (!selectedIds.has(o.id)) onToggleSelection(o.id);
    });
  };

  const deselectAll = () => {
    filteredObjects.forEach(o => {
      if (selectedIds.has(o.id)) onToggleSelection(o.id);
    });
  };

  if (isDiscovering) {
    return (
      <Card className="p-8">
        <div className="flex flex-col items-center justify-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-muted-foreground font-medium">Descobrindo objetos disponíveis...</p>
          <p className="text-xs text-muted-foreground">Isso pode levar alguns segundos</p>
        </div>
      </Card>
    );
  }

  if (objects.length === 0) {
    return (
      <Card className="p-8">
        <div className="flex flex-col items-center justify-center gap-4 text-center">
          <Database className="w-12 h-12 text-muted-foreground/50" />
          <div>
            <p className="font-medium text-muted-foreground">Nenhum objeto encontrado</p>
            <p className="text-sm text-muted-foreground mt-1">Execute o discovery para listar tabelas, views e modelos disponíveis</p>
          </div>
          <Button onClick={onRediscover} variant="outline" size="sm">
            Executar Discovery
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header + search */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {objects.length} objetos
          </Badge>
          {selectedIds.size > 0 && (
            <Badge className="text-xs bg-primary">
              {selectedIds.size} selecionado(s)
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={selectAll} className="text-xs">
            Selecionar todos
          </Button>
          <Button variant="ghost" size="sm" onClick={deselectAll} className="text-xs">
            Limpar
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Buscar por nome ou schema..."
            className="pl-10"
          />
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant={typeFilter === null ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTypeFilter(null)}
            className="text-xs"
          >
            Todos
          </Button>
          {types.map(type => (
            <Button
              key={type}
              variant={typeFilter === type ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setTypeFilter(type)}
              className="text-xs"
            >
              {type}
            </Button>
          ))}
        </div>
      </div>

      {/* Objects grid */}
      <ScrollArea className="h-[400px]">
        <div className="space-y-1">
          {/* Table header */}
          <div className="grid grid-cols-[40px_1fr_100px_100px_100px_100px_80px] gap-2 px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider border-b">
            <div></div>
            <div>Nome</div>
            <div>Tipo</div>
            <div>Schema</div>
            <div>Colunas</div>
            <div>Linhas</div>
            <div></div>
          </div>

          {filteredObjects.map(obj => {
            const TypeIcon = TYPE_ICONS[obj.object_type] || Table;
            const classColor = CLASSIFICATION_COLORS[obj.classification || 'unknown'];
            const isSelected = selectedIds.has(obj.id);

            return (
              <div
                key={obj.id}
                className={`grid grid-cols-[40px_1fr_100px_100px_100px_100px_80px] gap-2 px-3 py-3 items-center rounded-lg transition-colors cursor-pointer ${
                  isSelected
                    ? "bg-primary/5 border border-primary/20"
                    : "hover:bg-muted/50 border border-transparent"
                }`}
                onClick={() => onToggleSelection(obj.id)}
              >
                <div className="flex justify-center">
                  <Checkbox checked={isSelected} onCheckedChange={() => onToggleSelection(obj.id)} />
                </div>

                <div className="flex items-center gap-2 min-w-0">
                  <TypeIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <span className="font-medium text-sm truncate">{obj.object_name}</span>
                  {obj.classification && obj.classification !== 'unknown' && (
                    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${classColor}`}>
                      {obj.classification}
                    </Badge>
                  )}
                </div>

                <div className="text-xs text-muted-foreground">{obj.object_type}</div>

                <div className="text-xs text-muted-foreground truncate" title={obj.object_schema || ''}>
                  {obj.object_schema || '—'}
                </div>

                <div className="text-xs text-muted-foreground">
                  {obj.estimated_columns != null ? obj.estimated_columns : '—'}
                </div>

                <div className="text-xs text-muted-foreground">
                  {obj.estimated_rows != null ? obj.estimated_rows.toLocaleString() : '—'}
                </div>

                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={e => { e.stopPropagation(); onInspect(obj.id); }}
                    title="Inspecionar"
                  >
                    <Eye className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Actions */}
      <div className="flex items-center justify-between pt-4 border-t">
        <Button variant="outline" size="sm" onClick={onRediscover}>
          Reexecutar Discovery
        </Button>
        <Button
          onClick={onImport}
          disabled={selectedIds.size === 0 || isImporting}
          className="bg-gradient-primary"
        >
          {isImporting ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Importando...
            </>
          ) : (
            <>
              <Download className="w-4 h-4 mr-2" />
              Importar {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
            </>
          )}
        </Button>
      </div>
    </div>
  );
};

export default DiscoveryGrid;
