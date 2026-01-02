import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, Table, Search, CheckCircle, Database, Layers } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";

interface TableInfo {
  schema: string;
  name: string;
  type: "table" | "view";
  rowCount?: number;
}

interface TableSelectorProps {
  tables: TableInfo[];
  isLoading: boolean;
  onSelectTable: (schema: string, tableName: string) => void;
  onCancel: () => void;
}

const TableSelector = ({ tables, isLoading, onSelectTable, onCancel }: TableSelectorProps) => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  const filteredTables = tables.filter(table => 
    table.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    table.schema.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group tables by schema
  const groupedTables = filteredTables.reduce((acc, table) => {
    if (!acc[table.schema]) {
      acc[table.schema] = [];
    }
    acc[table.schema].push(table);
    return acc;
  }, {} as Record<string, TableInfo[]>);

  const handleConfirm = () => {
    if (selectedTable) {
      const [schema, name] = selectedTable.split(".");
      onSelectTable(schema, name);
    }
  };

  if (isLoading) {
    return (
      <Card className="p-8">
        <div className="flex flex-col items-center justify-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-muted-foreground">{t("dataIngestion.database.loadingTables")}</p>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold flex items-center gap-2">
          <Layers className="w-5 h-5 text-primary" />
          {t("dataIngestion.database.selectTable")}
        </h3>
        <Badge variant="outline">
          {tables.length} {t("dataIngestion.database.tablesFound")}
        </Badge>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("dataIngestion.database.searchTables")}
          className="pl-10"
        />
      </div>

      {/* Tables list */}
      <ScrollArea className="h-[300px] border rounded-lg">
        <RadioGroup 
          value={selectedTable || ""} 
          onValueChange={setSelectedTable}
          className="p-2"
        >
          {Object.entries(groupedTables).map(([schema, schemaTables]) => (
            <div key={schema} className="mb-4 last:mb-0">
              <div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <Database className="w-3 h-3" />
                {schema}
              </div>
              <div className="space-y-1">
                {schemaTables.map((table) => {
                  const tableId = `${table.schema}.${table.name}`;
                  return (
                    <Label
                      key={tableId}
                      htmlFor={tableId}
                      className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                        selectedTable === tableId
                          ? "bg-primary/10 border border-primary/30"
                          : "hover:bg-muted/50 border border-transparent"
                      }`}
                    >
                      <RadioGroupItem value={tableId} id={tableId} />
                      <div className="flex items-center gap-2 flex-1">
                        <Table className="w-4 h-4 text-muted-foreground" />
                        <span className="font-medium">{table.name}</span>
                        {table.type === "view" && (
                          <Badge variant="secondary" className="text-xs">
                            {t("dataIngestion.database.view")}
                          </Badge>
                        )}
                      </div>
                      {table.rowCount !== undefined && (
                        <span className="text-xs text-muted-foreground">
                          {table.rowCount.toLocaleString()} {t("dataIngestion.file.rows")}
                        </span>
                      )}
                      {selectedTable === tableId && (
                        <CheckCircle className="w-4 h-4 text-primary" />
                      )}
                    </Label>
                  );
                })}
              </div>
            </div>
          ))}
          
          {filteredTables.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              {searchQuery 
                ? t("dataIngestion.database.noTablesMatch")
                : t("dataIngestion.database.noTablesFound")}
            </div>
          )}
        </RadioGroup>
      </ScrollArea>

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <Button variant="outline" onClick={onCancel} className="flex-1">
          {t("common.cancel")}
        </Button>
        <Button 
          onClick={handleConfirm} 
          disabled={!selectedTable}
          className="flex-1"
        >
          {t("dataIngestion.database.importTable")}
        </Button>
      </div>
    </Card>
  );
};

export default TableSelector;
