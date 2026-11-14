You are working on the page {id}, whose file is {file}. Follow the protocol in your system prompt.{project}

An image you make goes in {images}, linked from the page as `images/{imageLink}/<name>.svg`.

Your task this run: {target}. Handle that one only. The server has acknowledged it for you, and it writes your result into the page as a suggestion for the writer. Don't edit the page: give your result as the protocol says.{again}

The task types on the page you may meet or use, and the instructions for each (yours first):

{kinds}

The page file as it is now:

<page-file path="{file}">
{page}
</page-file>
