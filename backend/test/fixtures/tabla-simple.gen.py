"""
Genera `tabla-simple.docx`: un Word minimo con encabezado, parrafo y una
tabla de 3x2. Lo lee `mammoth` en `document-extractor.util.spec.ts`.

El binario se versiona porque construirlo dentro de la prueba ataria el
fixture a la libreria que se quiere ejercitar. Este generador se versiona
al lado para que el binario no sea opaco en una revision, igual que
`nota-nativa.ps` acompana a `nota-nativa.pdf`. Solo usa la biblioteca
estandar de Python: no hace falta LibreOffice ni ningun binario del
sistema.

Uso:
    python3 tabla-simple.gen.py <ruta-de-salida>
"""
import zipfile, sys

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

CT = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''

ROOT_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

def p(text, style=None):
    ppr = '<w:pPr><w:pStyle w:val="%s"/></w:pPr>' % style if style else ''
    return '<w:p>%s<w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % (ppr, text)

def tc(text):
    return '<w:tc><w:tcPr/>%s</w:tc>' % p(text)

def tr(cells):
    return '<w:tr>%s</w:tr>' % ''.join(tc(c) for c in cells)

TABLE = ('<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>'
         + tr(['Ciudad', 'Empleos'])
         + tr(['Madrid', '200'])
         + tr(['Sevilla', '80'])
         + '</w:tbl>')

DOC = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
       '<w:document xmlns:w="%s"><w:body>%s%s%s</w:body></w:document>'
       % (W, p('Nueva sede corporativa', 'Heading1'),
          p('La compania inaugura su nueva sede.'), TABLE))

with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CT)
    z.writestr('_rels/.rels', ROOT_RELS)
    z.writestr('word/document.xml', DOC)
print('escrito', sys.argv[1])
