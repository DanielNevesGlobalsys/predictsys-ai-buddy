import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Hash, Type, Calendar, ToggleLeft, HelpCircle } from "lucide-react";

interface ColumnInfo {
  name: string;
  type: string;
  index: number;
}

interface DataPreviewSectionProps {
  columns: ColumnInfo[];
  previewRows: Record<string, unknown>[];
  totalRows: number;
  sampleRows: number;
  isSampled?: boolean;
}

const getTypeIcon = (type: string) => {
  switch (type) {
    case "numérico":
    case "numeric":
      return <Hash className="w-3 h-3" />;
    case "data":
    case "date":
      return <Calendar className="w-3 h-3" />;
    case "booleano":
    case "boolean":
      return <ToggleLeft className="w-3 h-3" />;
    case "categórico":
    case "categorical":
      return <Type className="w-3 h-3" />;
    default:
      return <Type className="w-3 h-3" />;
  }
};

const getTypeBadgeColor = (type: string) => {
  switch (type) {
    case "numérico":
    case "numeric":
      return "bg-blue-500/10 text-blue-600 border-blue-500/30";
    case "data":
    case "date":
      return "bg-amber-500/10 text-amber-600 border-amber-500/30";
    case "booleano":
    case "boolean":
      return "bg-purple-500/10 text-purple-600 border-purple-500/30";
    case "categórico":
    case "categorical":
      return "bg-green-500/10 text-green-600 border-green-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
};

const DataPreviewSection = ({
  columns,
  previewRows,
  totalRows,
  sampleRows,
  isSampled = false
}: DataPreviewSectionProps) => {
  const { t } = useTranslation();

  if (columns.length === 0 || previewRows.length === 0) {
    return null;
  }

  // Calculate basic stats per column
  const columnStats = columns.map(col => {
    const values = previewRows.map(row => row[col.name]);
    const nonNullValues = values.filter(v => v !== null && v !== undefined && v !== "");
    const nullCount = values.length - nonNullValues.length;
    
    let stats: Record<string, unknown> = {
      nullCount,
      nullPercentage: ((nullCount / values.length) * 100).toFixed(1)
    };

    if (col.type === "numérico" || col.type === "numeric") {
      const numericValues = nonNullValues
        .map(v => parseFloat(String(v).replace(",", ".")))
        .filter(v => !isNaN(v));
      
      if (numericValues.length > 0) {
        stats.min = Math.min(...numericValues).toFixed(2);
        stats.max = Math.max(...numericValues).toFixed(2);
        stats.mean = (numericValues.reduce((a, b) => a + b, 0) / numericValues.length).toFixed(2);
      }
    } else {
      const uniqueValues = new Set(nonNullValues.map(v => String(v)));
      stats.uniqueCount = uniqueValues.size;
    }

    return { ...col, stats };
  });

  return (
    <div className="space-y-6">
      {/* Column statistics */}
      <Card className="p-4">
        <h3 className="font-semibold mb-4 flex items-center gap-2">
          {t("dataIngestion.preview.columnStats")}
          <Badge variant="outline" className="font-normal">
            {columns.length} {t("dataIngestion.file.columns")}
          </Badge>
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {columnStats.map((col, i) => (
            <div 
              key={i} 
              className="p-3 bg-muted/30 rounded-lg border border-border/50 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-sm truncate flex-1" title={col.name}>
                  {col.name}
                </span>
                <Badge 
                  variant="outline" 
                  className={`text-xs shrink-0 ${getTypeBadgeColor(col.type)}`}
                >
                  {getTypeIcon(col.type)}
                  <span className="ml-1">{col.type}</span>
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground space-y-1">
                {typeof col.stats.nullCount === 'number' && col.stats.nullCount > 0 && (
                  <div className="flex justify-between">
                    <span>{t("dataIngestion.preview.nulls")}</span>
                    <span className="text-amber-500">
                      {col.stats.nullCount} ({String(col.stats.nullPercentage)}%)
                    </span>
                  </div>
                )}
                {(col.type === "numérico" || col.type === "numeric") && col.stats.min !== undefined && (
                  <>
                    <div className="flex justify-between">
                      <span>{t("dataIngestion.preview.range")}</span>
                      <span>{String(col.stats.min)} – {String(col.stats.max)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>{t("dataIngestion.preview.mean")}</span>
                      <span>{String(col.stats.mean)}</span>
                    </div>
                  </>
                )}
                {typeof col.stats.uniqueCount === 'number' && (
                  <div className="flex justify-between">
                    <span>{t("dataIngestion.preview.unique")}</span>
                    <span>{col.stats.uniqueCount}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Data preview table */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{t("dataIngestion.file.preview")}</h3>
          <span className="text-sm text-muted-foreground">
            {t("dataIngestion.file.showingRows", { 
              shown: previewRows.length, 
              total: sampleRows 
            })}
            {isSampled && (
              <span className="ml-2 text-primary">
                ({t("dataIngestion.file.sampledIndicator", { total: totalRows.toLocaleString() })})
              </span>
            )}
          </span>
        </div>
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="w-10 text-center font-medium">#</TableHead>
                  {columns.map((col, i) => (
                    <TableHead key={i} className="font-medium">
                      <div className="space-y-1">
                        <span>{col.name}</span>
                        <Badge 
                          variant="outline" 
                          className={`text-xs block w-fit ${getTypeBadgeColor(col.type)}`}
                        >
                          {col.type}
                        </Badge>
                      </div>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {previewRows.map((row, rowIndex) => (
                  <TableRow key={rowIndex} className="hover:bg-muted/30">
                    <TableCell className="text-center text-muted-foreground text-xs">
                      {rowIndex + 1}
                    </TableCell>
                    {columns.map((col, cellIndex) => {
                      const value = row[col.name];
                      const isEmpty = value === null || value === undefined || value === "";
                      
                      return (
                        <TableCell key={cellIndex} className="text-sm">
                          {isEmpty ? (
                            <span className="text-muted-foreground/50 italic">
                              {t("dataIngestion.file.empty")}
                            </span>
                          ) : (
                            <span className="truncate max-w-[200px] block" title={String(value)}>
                              {String(value)}
                            </span>
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default DataPreviewSection;
