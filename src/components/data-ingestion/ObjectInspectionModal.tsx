import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Key, Clock, Hash } from "lucide-react";

interface ColumnDetail {
  name: string;
  type: string;
  is_key: boolean;
  is_temporal: boolean;
  nullable?: boolean;
}

interface ObjectInspectionModalProps {
  open: boolean;
  onClose: () => void;
  objectName: string;
  columns: ColumnDetail[] | null;
  rows: Record<string, any>[] | null;
  isLoading: boolean;
}

const ObjectInspectionModal = ({ open, onClose, objectName, columns, rows, isLoading }: ObjectInspectionModalProps) => {
  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Hash className="w-5 h-5 text-primary" />
            Inspeção: {objectName}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Carregando dados...</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 overflow-hidden flex-1">
            {/* Column details */}
            {columns && columns.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                  Colunas ({columns.length})
                </h4>
                <ScrollArea className="h-[200px] border rounded-lg">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nome</TableHead>
                        <TableHead>Tipo</TableHead>
                        <TableHead>Atributos</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {columns.map((col, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-mono text-sm">{col.name}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {col.type}
                            </Badge>
                          </TableCell>
                          <TableCell className="flex items-center gap-1">
                            {col.is_key && (
                              <Badge variant="secondary" className="text-[10px] gap-1">
                                <Key className="w-3 h-3" />
                                Key
                              </Badge>
                            )}
                            {col.is_temporal && (
                              <Badge variant="secondary" className="text-[10px] gap-1">
                                <Clock className="w-3 h-3" />
                                Temporal
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </div>
            )}

            {/* Preview rows */}
            {rows && rows.length > 0 && (
              <div className="flex-1 overflow-hidden">
                <h4 className="text-sm font-semibold mb-2">
                  Preview ({rows.length} linhas)
                </h4>
                <ScrollArea className="h-[250px] border rounded-lg">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {Object.keys(rows[0]).map(col => (
                            <TableHead key={col} className="text-xs whitespace-nowrap">
                              {col}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.slice(0, 50).map((row, idx) => (
                          <TableRow key={idx}>
                            {Object.values(row).map((val, ci) => (
                              <TableCell key={ci} className="text-xs whitespace-nowrap max-w-[200px] truncate">
                                {val === null || val === undefined ? (
                                  <span className="text-muted-foreground italic">null</span>
                                ) : (
                                  String(val)
                                )}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </ScrollArea>
              </div>
            )}

            {(!columns || columns.length === 0) && (!rows || rows.length === 0) && (
              <div className="text-center py-8 text-muted-foreground">
                Nenhum dado disponível para este objeto
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default ObjectInspectionModal;
